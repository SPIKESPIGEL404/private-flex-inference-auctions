//! Market purchase E2EE helpers.
//!
//! Reuses the ACI E2EE v2 X25519 construction from
//! `Dstack-TEE/private-ai-gateway@0edde219` `src/aci/e2ee.rs` for a single
//! Market extension field (`bitrouter_purchase`). This is not a full ACI E2EE
//! v2 terminator: response encryption and content-field encryption are out of
//! scope, and `supported_e2ee_versions` is not advertised.
use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{Aead, KeyInit};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519SecretKey};

pub const E2EE_VERSION: &str = "2";
pub const E2EE_ALGO_X25519: &str = "x25519-aes-256-gcm-hkdf-sha256";
pub const E2EE_KEY_ID: &str = "market-e2ee-v1";
pub const FIELD_PURCHASE: &str = "bitrouter_purchase";
pub const AAD_PURPOSE: &str = "aci.e2ee.request.v2";
const X25519_HKDF_INFO: &[u8] = b"aci.e2ee.v2.x25519";
const X25519_PUBLIC_KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
/// Hex encoding of ephemeral(32)+nonce(12)+tag(16)+small purchase JSON.
pub const PURCHASE_CIPHERTEXT_HEX_MAX: usize = 4 * 1024;

#[derive(Debug)]
pub enum E2eeError {
    Crypto,
}

pub fn generate_secret() -> Result<X25519SecretKey, E2eeError> {
    let mut bytes = [0u8; 32];
    getrandom_fill(&mut bytes)?;
    Ok(X25519SecretKey::from(bytes))
}

pub fn public_key_hex(secret: &X25519SecretKey) -> String {
    hex::encode(X25519PublicKey::from(secret).as_bytes())
}

pub fn normalize_public_key_hex(value: &str) -> Result<String, E2eeError> {
    let bytes =
        hex::decode(value.strip_prefix("0x").unwrap_or(value)).map_err(|_| E2eeError::Crypto)?;
    let bytes: [u8; X25519_PUBLIC_KEY_LEN] =
        bytes.as_slice().try_into().map_err(|_| E2eeError::Crypto)?;
    Ok(hex::encode(bytes))
}

/// Used by cross-language vector tests (and available for response E2EE later).
#[allow(dead_code)]
pub fn encrypt_for_public_key(
    recipient_public_key_hex: &str,
    plaintext: &[u8],
    aad: &[u8],
) -> Result<String, E2eeError> {
    let recipient = public_key_from_hex(recipient_public_key_hex)?;
    let mut eph_bytes = [0u8; 32];
    getrandom_fill(&mut eph_bytes)?;
    let ephemeral = X25519SecretKey::from(eph_bytes);
    let ephemeral_public = X25519PublicKey::from(&ephemeral);
    let shared = ephemeral.diffie_hellman(&recipient);
    let cipher = cipher_from_shared(shared.as_bytes())?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    getrandom_fill(&mut nonce_bytes)?;
    let ciphertext = cipher
        .encrypt(
            &nonce_bytes.into(),
            aes_gcm::aead::Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| E2eeError::Crypto)?;
    let mut out = Vec::with_capacity(X25519_PUBLIC_KEY_LEN + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(ephemeral_public.as_bytes());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(hex::encode(out))
}

pub fn decrypt_with_secret(
    recipient_secret: &X25519SecretKey,
    ciphertext_hex: &str,
    aad: &[u8],
) -> Result<Vec<u8>, E2eeError> {
    let blob = hex::decode(ciphertext_hex.strip_prefix("0x").unwrap_or(ciphertext_hex))
        .map_err(|_| E2eeError::Crypto)?;
    if blob.len() < X25519_PUBLIC_KEY_LEN + NONCE_LEN + TAG_LEN {
        return Err(E2eeError::Crypto);
    }
    let eph_bytes: [u8; X25519_PUBLIC_KEY_LEN] = blob[..X25519_PUBLIC_KEY_LEN]
        .try_into()
        .map_err(|_| E2eeError::Crypto)?;
    let eph = X25519PublicKey::from(eph_bytes);
    let nonce_bytes: [u8; NONCE_LEN] = blob
        [X25519_PUBLIC_KEY_LEN..X25519_PUBLIC_KEY_LEN + NONCE_LEN]
        .try_into()
        .map_err(|_| E2eeError::Crypto)?;
    let ciphertext = &blob[X25519_PUBLIC_KEY_LEN + NONCE_LEN..];
    let shared = recipient_secret.diffie_hellman(&eph);
    let cipher = cipher_from_shared(shared.as_bytes())?;
    cipher
        .decrypt(
            &nonce_bytes.into(),
            aes_gcm::aead::Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| E2eeError::Crypto)
}

/// Heuristic: lowercase/upper hex of at least ephemeral+nonce+tag (60 bytes).
pub fn looks_like_x25519_ciphertext(value: &str) -> bool {
    let raw = value.strip_prefix("0x").unwrap_or(value);
    raw.len() >= (X25519_PUBLIC_KEY_LEN + NONCE_LEN + TAG_LEN) * 2
        && raw.len().is_multiple_of(2)
        && raw
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || (b'A'..=b'F').contains(&b))
}

#[allow(dead_code)]
fn public_key_from_hex(value: &str) -> Result<X25519PublicKey, E2eeError> {
    let normalized = normalize_public_key_hex(value)?;
    let bytes: [u8; X25519_PUBLIC_KEY_LEN] = hex::decode(normalized)
        .map_err(|_| E2eeError::Crypto)?
        .as_slice()
        .try_into()
        .map_err(|_| E2eeError::Crypto)?;
    Ok(X25519PublicKey::from(bytes))
}

fn cipher_from_shared(shared: &[u8]) -> Result<Aes256Gcm, E2eeError> {
    let hk = Hkdf::<Sha256>::new(None, shared);
    let mut key = [0u8; 32];
    hk.expand(X25519_HKDF_INFO, &mut key)
        .map_err(|_| E2eeError::Crypto)?;
    Aes256Gcm::new_from_slice(&key).map_err(|_| E2eeError::Crypto)
}

fn getrandom_fill(buf: &mut [u8]) -> Result<(), E2eeError> {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(buf))
        .map_err(|_| E2eeError::Crypto)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn x25519_round_trip() {
        let secret = generate_secret().unwrap();
        let public = public_key_hex(&secret);
        let aad = b"{\"purpose\":\"aci.e2ee.request.v2\"}";
        let ct = encrypt_for_public_key(&public, b"{\"a\":1}", aad).unwrap();
        assert!(looks_like_x25519_ciphertext(&ct));
        assert_eq!(
            decrypt_with_secret(&secret, &ct, aad).unwrap(),
            b"{\"a\":1}"
        );
    }

    fn vectors_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../clients/market-buyer/test/vectors")
    }

    #[test]
    fn decrypts_node_to_rust_vector() {
        let path = vectors_dir().join("e2ee-node-to-rust.json");
        if !path.exists() {
            // npm test writes this first; allow isolated cargo test.
            return;
        }
        let vector: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let secret_bytes = hex::decode(vector["secret_hex"].as_str().unwrap()).unwrap();
        let secret = x25519_secret_key_from_bytes_local(&secret_bytes).unwrap();
        let aad = vector["aad_utf8"].as_str().unwrap().as_bytes();
        let plain =
            decrypt_with_secret(&secret, vector["ciphertext_hex"].as_str().unwrap(), aad).unwrap();
        let got: serde_json::Value = serde_json::from_slice(&plain).unwrap();
        assert_eq!(got, vector["purchase"]);
    }

    #[test]
    fn writes_rust_to_node_vector() {
        let seed = [0x42u8; 32];
        let secret = X25519SecretKey::from(seed);
        let public = public_key_hex(&secret);
        let purchase = json!({
            "service_type": "on_demand",
            "provider_cap_micro_usd": 4500,
            "total_cap_micro_usd": 4510
        });
        let nonce = "ef".repeat(32);
        let ts = 1_700_000_002_i64;
        let aad = aci_protocol::digest::jcs_bytes(&json!({
            "purpose": AAD_PURPOSE,
            "algo": E2EE_ALGO_X25519,
            "model": "m/external",
            "field": FIELD_PURCHASE,
            "nonce": nonce,
            "ts": ts,
        }))
        .unwrap();
        let plaintext = serde_json::to_vec(&purchase).unwrap();
        let ciphertext = encrypt_for_public_key(&public, &plaintext, &aad).unwrap();
        assert_eq!(
            decrypt_with_secret(&secret, &ciphertext, &aad).unwrap(),
            plaintext
        );
        let dir = vectors_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let out = json!({
            "secret_hex": hex::encode(seed),
            "model": "m/external",
            "nonce": nonce,
            "ts": ts,
            "purchase": purchase,
            "ciphertext_hex": ciphertext,
        });
        std::fs::write(
            dir.join("e2ee-rust-to-node.json"),
            serde_json::to_vec_pretty(&out).unwrap(),
        )
        .unwrap();
    }

    fn x25519_secret_key_from_bytes_local(bytes: &[u8]) -> Result<X25519SecretKey, E2eeError> {
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| E2eeError::Crypto)?;
        Ok(X25519SecretKey::from(bytes))
    }
}
