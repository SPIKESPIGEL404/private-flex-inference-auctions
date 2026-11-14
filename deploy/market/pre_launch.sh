#!/bin/bash
# Explicit measured pre_launch_script for this Market app-compose.
#
# Phala Cloud's default pre_launch_script (v0.0.21,
# sha256 0xc452d7122315255914858880fa3d7931f965f57d04631ead4b7164736bcd0765)
# signs in to private registries, prunes unused Docker images/volumes, pulls
# images, and can set a root password and SSH keys. This deployment
# intentionally does NOT enable SSH or root login.
#
# Deploy MUST use the rendered app-compose.json that embeds THIS script so the
# compose hash matches RTMR3. Do not let the dashboard substitute a different
# pre_launch_script. Encrypted operator inputs are limited by allowed_envs to
# BUYER_0_TOKEN, BUYER_1_TOKEN, and BUYER_2_TOKEN only (tls-alpn-01; no DNS
# credentials; ACME_EMAIL left unset because it is published in evidence).
set -euo pipefail
exit 0
