This release packages public configuration, startup source, pinned tokenizer
assets, and the existing domain ingress adaptation into ordinary Docker images.
CVM startup needs no pre-launch script, host image loader, or generated `/run`
file mounts. Credentials remain sealed environment variables or the existing
legacy credential files. Original ledger and certificate volumes are retained.

Run the manual **Publish packaged Phala images** GitHub Actions workflow. It
verifies each public base archive part and the complete archive before loading,
checks the packaged runtime source against the repository, publishes images to
GHCR, and produces `published-images.json` with immutable registry digests.
Packages must permit the CVM to pull them; anonymous pull is checked separately
before applying the deployment.

The market entrypoint checks the exact failed pre-registration v2 evidence,
retains that directory, materializes only pinned public tokenizer assets in v3,
and invokes the existing guarded bootstrap. It never resets an incomplete v3
qualification or repeats a possibly invoked calibration. The predecessor Market
container must stop before its replacement starts. The temporary domain probe
uses a new named volume; its old host diagnostic output is not migrated.

Render with `scripts/prepare-packaged-phala.py`. The output explicitly sets
`pre_launch_script` to an empty string and preserves VM settings and allowed
sealed environment keys. Compare the live manifest immediately before applying,
then verify the exact returned manifest and hosted endpoints afterward. Use the
Phala CLI `--no-pre-launch-script` flag explicitly: passing an empty script file
selects the platform default and does not mean that pre-launch is disabled.

The public workspace remains controlled P2. This packaging does not enable
native-funded B/browser inference. The earlier Phala policy rejection does not
establish the trigger; this retry follows the user's report that the Phala team
recommended testing without a pre-launch script.
