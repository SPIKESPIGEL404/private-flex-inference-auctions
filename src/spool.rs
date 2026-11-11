//! Fixed-size, physically allocated result slots. Journal checkpoints bound the
//! committed prefix; bytes after that prefix have no authority after a crash.
use crate::*;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

const MAGIC: &[u8; 8] = b"FLEXR01\n";
pub const RESULT_HEADER_BYTES: u64 = 40;
pub const RESULT_FOOTER_BYTES: u64 = 32;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpoolPolicy {
    pub acknowledged_retention_ms: u64,
    pub max_artifact_bytes: u64,
    pub max_physical_bytes: u64,
    pub max_owner_physical_bytes: u64,
}

impl SpoolPolicy {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.acknowledged_retention_ms > i64::MAX as u64
            || self.max_physical_bytes > i64::MAX as u64
            || self.max_owner_physical_bytes == 0
            || self.max_owner_physical_bytes > self.max_physical_bytes
            || !(72..=64 * 1024 * 1024).contains(&self.max_artifact_bytes)
        {
            return Err(Error::Invalid("spool policy limits"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpoolReservation {
    pub key: String,
    pub binding_digest: String,
    pub capacity: u64,
    pub allocation_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpoolCheckpoint {
    pub used_bytes: u64,
    pub prefix_digest: String,
    pub records: u64,
    pub generated_tokens: u64,
    pub text_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactMetadata {
    pub artifact_ref: String,
    pub digest: String,
    pub used_bytes: u64,
    pub records: u64,
    pub usage: Usage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandoffAck {
    pub digest: String,
    pub sink_receipt_ref: String,
    pub acknowledged_at_ms: u64,
    pub cleanup_after_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupIntent {
    pub evidence_ref: String,
    pub unavailable: bool,
}

/// Returned only to a trusted adapter after owner binding and full file checks.
/// Deliberately no Debug impl: artifacts contain plaintext inference output.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResultArtifact {
    pub binding: ExecutionBinding,
    pub metadata: ArtifactMetadata,
    pub text: String,
    pub token_ids: Vec<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpoolOperation {
    Allocate,
    Write,
    SyncFile,
    Read,
    Remove,
    SyncDirectory,
}

/// Fault hook for storage acceptance tests. No hook is selectable over the wire.
pub trait SpoolFaults: Send + Sync {
    fn before(&self, operation: SpoolOperation) -> std::io::Result<()>;
}
pub(crate) struct NoSpoolFaults;
impl SpoolFaults for NoSpoolFaults {
    fn before(&self, _: SpoolOperation) -> std::io::Result<()> {
        Ok(())
    }
}

pub(crate) struct LocalSpool {
    root: PathBuf,
    _lock: File,
    policy: SpoolPolicy,
    faults: Arc<dyn SpoolFaults>,
}

impl LocalSpool {
    pub fn open(
        root: PathBuf,
        policy: SpoolPolicy,
        config_hash: &str,
        existing_binding: bool,
        faults: Arc<dyn SpoolFaults>,
    ) -> Result<Self> {
        policy.validate()?;
        if existing_binding && !root.is_dir() {
            return Err(Error::Corrupt("missing bound spool root"));
        }
        if root.exists() && fs::symlink_metadata(&root)?.file_type().is_symlink() {
            return Err(Error::Invalid("spool root symlink"));
        }
        fs::create_dir_all(&root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        }
        let lock = private_open(&root.join(".writer.lock"), true)?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Err(Error::WriterLocked),
            Err(TryLockError::Error(e)) => return Err(e.into()),
        }
        let marker = root.join("binding.json");
        let expected = canonical_bytes(&("flex-result-spool-v1", config_hash, &policy))?;
        if marker.exists() {
            if !existing_binding {
                return Err(Error::Corrupt(
                    "spool binding exists without journal policy",
                ));
            }
            if fs::symlink_metadata(&marker)?.file_type().is_symlink()
                || fs::read(&marker)? != expected
            {
                return Err(Error::ConfigMismatch);
            }
        } else {
            if existing_binding {
                return Err(Error::Corrupt("missing spool binding"));
            }
            // Unknown existing files may not be adopted into a new spool binding.
            if fs::read_dir(&root)?
                .filter_map(std::result::Result::ok)
                .any(|e| e.file_name() != ".writer.lock")
            {
                return Err(Error::Corrupt("unbound spool files"));
            }
            let mut file = private_open_new(&marker)?;
            file.write_all(&expected)?;
            file.sync_all()?;
        }
        let spool = Self {
            root,
            _lock: lock,
            policy,
            faults,
        };
        spool.sync_dir()?;
        if let Some(parent) = spool.root.parent() {
            File::open(parent)?.sync_all()?;
        }
        Ok(spool)
    }

    pub fn key(execution_id: &str) -> Result<String> {
        digest("flex-scheduler/result-slot/v1", &execution_id)
    }

    fn path(&self, key: &str) -> Result<PathBuf> {
        crate::contracts::decode_hex::<32>(key)?;
        Ok(self.root.join(format!("{key}.slot")))
    }

    pub fn slots(&self) -> Result<Vec<String>> {
        let mut slots = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_str().ok_or(Error::Corrupt("spool filename"))?;
            if name == "binding.json" || name == ".writer.lock" {
                continue;
            }
            let key = name
                .strip_suffix(".slot")
                .ok_or(Error::Corrupt("unexpected spool entry"))?;
            crate::contracts::decode_hex::<32>(key)?;
            if !entry.file_type()?.is_file() {
                return Err(Error::Corrupt("nonregular spool entry"));
            }
            slots.push(key.to_string());
        }
        Ok(slots)
    }

    pub fn reserve(
        &self,
        binding: &ExecutionBinding,
        capacity: u64,
    ) -> Result<(SpoolReservation, SpoolCheckpoint)> {
        if capacity > self.policy.max_artifact_bytes
            || capacity < RESULT_HEADER_BYTES + RESULT_FOOTER_BYTES
        {
            return Err(Error::Invalid("slot capacity"));
        }
        let key = Self::key(&binding.execution_id)?;
        let binding_digest = digest("flex-scheduler/result-binding/v1", binding)?;
        let reservation = SpoolReservation {
            key,
            binding_digest,
            capacity,
            allocation_bytes: allocation_bytes(capacity)?,
        };
        let mut file = private_open_new(&self.path(&reservation.key)?)?;
        self.faults.before(SpoolOperation::Allocate)?;
        if !cfg!(any(target_os = "macos", target_os = "linux")) {
            return Err(Error::Invalid("physical allocation backend unsupported"));
        }
        FileExt::allocate(&file, reservation.allocation_bytes)?;
        if FileExt::allocated_size(&file)? != reservation.allocation_bytes {
            return Err(Error::Invalid(
                "filesystem allocation granularity unsupported",
            ));
        }
        let header = header(&reservation)?;
        file.write_all(&header)?;
        self.faults.before(SpoolOperation::SyncFile)?;
        file.sync_all()?;
        self.sync_dir()?;
        Ok((
            reservation,
            SpoolCheckpoint {
                used_bytes: RESULT_HEADER_BYTES,
                prefix_digest: raw_digest(&header),
                records: 0,
                generated_tokens: 0,
                text_bytes: 0,
            },
        ))
    }

    pub fn append(
        &self,
        reservation: &SpoolReservation,
        checkpoint: &SpoolCheckpoint,
        text: &str,
        ids: &[u32],
    ) -> Result<SpoolCheckpoint> {
        let prefix = self.prefix(reservation, checkpoint)?;
        if text.is_empty() && ids.is_empty() {
            return Ok(checkpoint.clone());
        }
        let mut record = Vec::new();
        record.extend_from_slice(
            &u32::try_from(text.len())
                .map_err(|_| Error::Invalid("result record size"))?
                .to_le_bytes(),
        );
        record.extend_from_slice(
            &u32::try_from(ids.len())
                .map_err(|_| Error::Invalid("result record tokens"))?
                .to_le_bytes(),
        );
        record.extend_from_slice(text.as_bytes());
        for token in ids {
            record.extend_from_slice(&token.to_le_bytes());
        }
        let used = checkpoint
            .used_bytes
            .checked_add(record.len() as u64)
            .ok_or(Error::Invalid("result size overflow"))?;
        if used
            .checked_add(RESULT_FOOTER_BYTES)
            .is_none_or(|n| n > reservation.capacity)
        {
            return Err(Error::Invalid("result exceeds reserved space"));
        }
        self.write(reservation, checkpoint.used_bytes, &record)?;
        let mut all = prefix;
        all.extend_from_slice(&record);
        Ok(SpoolCheckpoint {
            used_bytes: used,
            prefix_digest: raw_digest(&all),
            records: checkpoint.records + 1,
            generated_tokens: checkpoint.generated_tokens + ids.len() as u64,
            text_bytes: checkpoint.text_bytes + text.len() as u64,
        })
    }

    pub fn prefix(
        &self,
        reservation: &SpoolReservation,
        checkpoint: &SpoolCheckpoint,
    ) -> Result<Vec<u8>> {
        let bytes = self.read(reservation, checkpoint.used_bytes)?;
        if bytes.len() < RESULT_HEADER_BYTES as usize
            || bytes[..RESULT_HEADER_BYTES as usize] != header(reservation)?
            || raw_digest(&bytes) != checkpoint.prefix_digest
        {
            return Err(Error::Corrupt("spool checkpoint or binding"));
        }
        let (text, ids, records) = decode_records(&bytes[RESULT_HEADER_BYTES as usize..])?;
        if ids.len() as u64 != checkpoint.generated_tokens
            || text.len() as u64 != checkpoint.text_bytes
            || records != checkpoint.records
        {
            return Err(Error::Corrupt("spool record counts"));
        }
        Ok(bytes)
    }

    pub fn finalize(
        &self,
        reservation: &SpoolReservation,
        checkpoint: &SpoolCheckpoint,
        usage: &Usage,
    ) -> Result<ArtifactMetadata> {
        let mut bytes = self.prefix(reservation, checkpoint)?;
        if usage.completion_tokens != checkpoint.generated_tokens {
            return Err(Error::Corrupt("artifact token count"));
        }
        let mut footer = Vec::new();
        for n in [
            usage.prompt_tokens,
            usage.completion_tokens,
            usage.total_tokens,
            checkpoint.records,
        ] {
            footer.extend_from_slice(&n.to_le_bytes());
        }
        self.write(reservation, checkpoint.used_bytes, &footer)?;
        bytes.extend_from_slice(&footer);
        Ok(ArtifactMetadata {
            artifact_ref: format!("spool:{}", reservation.key),
            digest: raw_digest(&bytes),
            used_bytes: bytes.len() as u64,
            records: checkpoint.records,
            usage: usage.clone(),
        })
    }

    pub fn artifact(
        &self,
        binding: ExecutionBinding,
        reservation: &SpoolReservation,
        metadata: &ArtifactMetadata,
    ) -> Result<ResultArtifact> {
        let bytes = self.read(reservation, metadata.used_bytes)?;
        if bytes.len() < (RESULT_HEADER_BYTES + RESULT_FOOTER_BYTES) as usize
            || raw_digest(&bytes) != metadata.digest
            || bytes[..RESULT_HEADER_BYTES as usize] != header(reservation)?
            || metadata.artifact_ref != format!("spool:{}", reservation.key)
            || digest("flex-scheduler/result-binding/v1", &binding)? != reservation.binding_digest
        {
            return Err(Error::Corrupt("artifact binding or digest"));
        }
        let payload_end = bytes.len() - RESULT_FOOTER_BYTES as usize;
        let (text, token_ids, records) =
            decode_records(&bytes[RESULT_HEADER_BYTES as usize..payload_end])?;
        let mut footer = Vec::new();
        for n in [
            metadata.usage.prompt_tokens,
            metadata.usage.completion_tokens,
            metadata.usage.total_tokens,
            metadata.records,
        ] {
            footer.extend_from_slice(&n.to_le_bytes());
        }
        if bytes[payload_end..] != footer
            || records != metadata.records
            || token_ids.len() as u64 != metadata.usage.completion_tokens
        {
            return Err(Error::Corrupt("artifact footer"));
        }
        Ok(ResultArtifact {
            binding,
            metadata: metadata.clone(),
            text,
            token_ids,
        })
    }

    fn read(&self, reservation: &SpoolReservation, used: u64) -> Result<Vec<u8>> {
        self.faults.before(SpoolOperation::Read)?;
        if used > reservation.capacity || reservation.capacity > self.policy.max_artifact_bytes {
            return Err(Error::Corrupt("spool size"));
        }
        let mut file = private_open(&self.path(&reservation.key)?, false)?;
        if file.metadata()?.len() != reservation.allocation_bytes {
            return Err(Error::Corrupt("allocated slot length"));
        }
        let mut bytes = vec![0; used as usize];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    }

    fn write(&self, reservation: &SpoolReservation, offset: u64, bytes: &[u8]) -> Result<()> {
        if offset
            .checked_add(bytes.len() as u64)
            .is_none_or(|n| n > reservation.capacity)
        {
            return Err(Error::Invalid("result exceeds reserved space"));
        }
        self.faults.before(SpoolOperation::Write)?;
        let mut file = private_open(&self.path(&reservation.key)?, false)?;
        if file.metadata()?.len() != reservation.allocation_bytes {
            return Err(Error::Corrupt("slot size changed"));
        }
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(bytes)?;
        self.faults.before(SpoolOperation::SyncFile)?;
        file.sync_all()?;
        Ok(())
    }

    pub fn remove(&self, key: &str) -> Result<()> {
        self.faults.before(SpoolOperation::Remove)?;
        match fs::remove_file(self.path(key)?) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        self.sync_dir()
    }
    fn sync_dir(&self) -> Result<()> {
        self.faults.before(SpoolOperation::SyncDirectory)?;
        File::open(&self.root)?.sync_all()?;
        Ok(())
    }
}

fn private_open(path: &Path, create: bool) -> Result<File> {
    if path.try_exists()? && fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(Error::Corrupt("spool symlink"));
    }
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create(create)
        .truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(Error::Corrupt("nonregular slot"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}
fn private_open_new(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}
fn header(r: &SpoolReservation) -> Result<Vec<u8>> {
    let mut b = MAGIC.to_vec();
    b.extend_from_slice(&crate::contracts::decode_hex::<32>(&r.binding_digest)?);
    Ok(b)
}
fn raw_digest(bytes: &[u8]) -> String {
    encode_hex(&Sha256::digest(bytes))
}

pub(crate) fn allocation_bytes(capacity: u64) -> Result<u64> {
    capacity
        .checked_add(4095)
        .map(|n| (n / 4096) * 4096)
        .ok_or(Error::Invalid("allocation overflow"))
}
fn decode_records(mut bytes: &[u8]) -> Result<(String, Vec<u32>, u64)> {
    let mut text = String::new();
    let mut ids = Vec::new();
    let mut records = 0;
    while !bytes.is_empty() {
        if bytes.len() < 8 {
            return Err(Error::Corrupt("truncated result record"));
        }
        let len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
        let count = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let end = 8usize
            .checked_add(len)
            .and_then(|n| count.checked_mul(4).and_then(|m| n.checked_add(m)))
            .ok_or(Error::Corrupt("record overflow"))?;
        if end > bytes.len() {
            return Err(Error::Corrupt("truncated result data"));
        }
        text.push_str(
            std::str::from_utf8(&bytes[8..8 + len]).map_err(|_| Error::Corrupt("result UTF-8"))?,
        );
        for token in bytes[8 + len..end].chunks_exact(4) {
            ids.push(u32::from_le_bytes(token.try_into().unwrap()));
        }
        records += 1;
        bytes = &bytes[end..];
    }
    Ok((text, ids, records))
}
