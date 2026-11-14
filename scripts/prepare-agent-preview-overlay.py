#!/usr/bin/env python3
"""Prepare an additive Phala update; never replaces sealed environments.

Input and output manifests can contain private deployment configuration. Keep
them outside git. Only the preservation assertion report is suitable to share.
Requires PyYAML on the release operator's computer.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import shlex
from urllib.parse import urlsplit

import yaml


def prepare(before, image, archive_url, archive_sha, owner_hash, revision, origin, fallback_origin=None):
    for value in [archive_sha, owner_hash]:
        if not re.fullmatch('[a-f0-9]{64}', value):
            raise ValueError('expected SHA-256')
    if not re.fullmatch('sha256:[a-f0-9]{64}', image) or not re.fullmatch('[a-f0-9]{40}', revision):
        raise ValueError('image and source must be pinned')
    url = urlsplit(archive_url)
    if not (url.scheme == 'https' and url.netloc == 'github.com' and not url.query and not url.fragment
            and re.fullmatch('/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', url.path)):
        raise ValueError('expected immutable GitHub release download path')
    public = urlsplit(origin)
    if not (public.scheme == 'https' and public.netloc == public.hostname and public.geturl() == 'https://' + public.hostname):
        raise ValueError('expected exact public HTTPS origin')
    if fallback_origin is not None:
        fallback=urlsplit(fallback_origin)
        if not (fallback.scheme=='https' and fallback.netloc==fallback.hostname and fallback.geturl()=='https://'+fallback.hostname):
            raise ValueError('expected exact fallback HTTPS origin')
    compose = yaml.safe_load(before['docker_compose_file'])
    updating = 'agent-preview' in compose['services']
    if not updating and ('agent-preview-data' in compose['volumes'] or 'agent-preview-private' in compose.get('networks', {})):
        raise ValueError('orphaned preview resources; inspect the current deployment')
    after = copy.deepcopy(before)
    overlay = copy.deepcopy(compose)
    if updating:
        previous = compose['services']['agent-preview']
        env = previous.get('environment', {})
        if env.get('AGENT_PREVIEW_ORIGIN') != origin or env.get('AGENT_PREVIEW_OWNER_HASH') != owner_hash:
            raise ValueError('preview origin or ownership cannot change during an image update')
        if 'agent-preview-data' not in compose['volumes'] or 'agent-preview-private' not in compose.get('networks', {}):
            raise ValueError('existing preview persistence/network missing')
        overlay['services']['agent-preview']['image'] = image
        overlay['services']['agent-preview']['environment']['AGENT_PREVIEW_REVISION'] = revision
    else:
        overlay['services']['agent-preview'] = {
            'image': image, 'pull_policy': 'never', 'restart': 'unless-stopped',
            'ports': ['3000:3000'], 'volumes': ['agent-preview-data:/data'],
            'networks': ['agent-preview-private'],
            'environment': {'AGENT_PREVIEW_ORIGIN': origin, 'AGENT_PREVIEW_OWNER_HASH': owner_hash,
                            'AGENT_PREVIEW_REVISION': revision},
            'read_only': True, 'tmpfs': ['/tmp:rw,nosuid,noexec,size=134217728,mode=1777'],
            'security_opt': ['no-new-privileges:true'], 'cap_drop': ['ALL'],
            'mem_limit': '1536m', 'cpus': 1.0, 'pids_limit': 192, 'stop_grace_period': '60s',
            'logging': {'driver': 'json-file', 'options': {'max-size': '5m', 'max-file': '2'}},
        }
        overlay['volumes']['agent-preview-data'] = {}
        # A dedicated ordinary bridge permits the host-published preview port.
        # It is not an egress firewall; controlled inference targets loopback.
        overlay.setdefault('networks', {})['agent-preview-private'] = {}
    if fallback_origin is not None:
        overlay['services']['agent-preview']['environment']['AGENT_PREVIEW_FALLBACK_ORIGIN']=fallback_origin
    after['docker_compose_file'] = yaml.safe_dump(overlay, sort_keys=False)
    loader = f'''
# Controlled agent preview. No gateway state or environment is modified below.
(
  set -eu
  preview_image='{image}'
  preview_sha='{archive_sha}'
  preview_cache=/dstack/persistent/agent-mpp-preview-images
  if ! docker image inspect "$preview_image" >/dev/null 2>&1; then
    mkdir -p "$preview_cache"
    preview_archive="$preview_cache/$preview_sha.tar.gz"
    if ! test -f "$preview_archive" || ! printf '%s  %s\\n' "$preview_sha" "$preview_archive" | sha256sum -c - >/dev/null 2>&1; then
      rm -f "$preview_archive.partial"
      curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 4 --connect-timeout 20 --max-time 600 {shlex.quote(archive_url)} -o "$preview_archive.partial"
      printf '%s  %s\\n' "$preview_sha" "$preview_archive.partial" | sha256sum -c -
      mv "$preview_archive.partial" "$preview_archive"
    fi
    gzip -dc "$preview_archive" | docker load
    docker image inspect "$preview_image" >/dev/null
  fi
)
'''
    after['pre_launch_script'] = before['pre_launch_script'] + loader
    assert all(overlay['services'][key] == value for key, value in compose['services'].items() if key != 'agent-preview')
    if updating:
        same = copy.deepcopy(overlay['services']['agent-preview'])
        same['image'] = compose['services']['agent-preview']['image']
        same['environment']['AGENT_PREVIEW_REVISION'] = compose['services']['agent-preview']['environment']['AGENT_PREVIEW_REVISION']
        if fallback_origin is not None:
            if 'AGENT_PREVIEW_FALLBACK_ORIGIN' in compose['services']['agent-preview']['environment']:
                same['environment']['AGENT_PREVIEW_FALLBACK_ORIGIN']=compose['services']['agent-preview']['environment']['AGENT_PREVIEW_FALLBACK_ORIGIN']
            else:
                same['environment'].pop('AGENT_PREVIEW_FALLBACK_ORIGIN',None)
        assert same == compose['services']['agent-preview']
    assert all(overlay['volumes'][key] == value for key, value in compose['volumes'].items())
    assert all(overlay['networks'][key] == value for key, value in compose.get('networks', {}).items())
    assert all(after[key] == value for key, value in before.items() if key not in ['docker_compose_file', 'pre_launch_script'])
    assert after['pre_launch_script'].startswith(before['pre_launch_script'])
    assert not before['requirements'].get('ephemeral_data_disk', False)
    assert not before['init_script'], 'inspect existing init scripts before updating'
    canonical = json.dumps(after, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    report = {'passed': True, 'sourceRevision': revision, 'image': image, 'archiveSha256': archive_sha,
              'expectedComposeHash': hashlib.sha256(canonical.encode()).hexdigest(),
              'operation': 'update' if updating else 'install',
              'existingPreviewUnchangedExceptImageRevision': updating and fallback_origin is None,
              'explicitFallbackOrigin': fallback_origin,
              'originalServiceDefinitionsUnchanged': [key for key in compose['services'] if key != 'agent-preview'],
              'originalVolumesUnchanged': list(compose['volumes']), 'sealedEnvironmentNamesUnchanged': True,
              'manifestMetadataUnchanged': True, 'preLaunchPrefixUnchanged': True,
              'originalNetworksUnchanged': list(compose.get('networks', {})),
              'newNetwork': {'agent-preview-private': {}}, 'networkEgressBlocked': False,
              'dataDiskEphemeral': False, 'initScriptUnchangedAndEmpty': True,
              'newService': overlay['services']['agent-preview'], 'newVolume': 'agent-preview-data'}
    return after, report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ['before', 'output', 'image', 'archive-url', 'archive-sha', 'owner-hash', 'revision', 'origin']:
        p.add_argument('--' + name, required=True)
    p.add_argument('--fallback-origin')
    args = p.parse_args()
    after, report = prepare(json.loads(Path(args.before).read_text()), args.image, args.archive_url,
                            args.archive_sha, args.owner_hash, args.revision, args.origin, args.fallback_origin)
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, value in [('app-compose.json', json.dumps(after)), ('compose.yaml', after['docker_compose_file']),
                        ('pre-launch.sh', after['pre_launch_script']), ('preservation.json', json.dumps(report, indent=2))]:
        path = out / name
        path.write_text(value)
        path.chmod(0o600)
    print(json.dumps({'expectedComposeHash': report['expectedComposeHash'], 'preservationPassed': True}))


if __name__ == '__main__':
    main()
