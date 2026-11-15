#!/usr/bin/env python3
"""Publish just the browser and controlled task-service update from CI."""
import json
import os
from pathlib import Path
import re
import subprocess


def run(*args):
    subprocess.run(args, check=True)


base = os.environ['WORKSPACE_BASE']
repository = 'ghcr.io/' + os.environ['GITHUB_REPOSITORY'].lower()
assert re.fullmatch(re.escape(repository) + r'@sha256:[a-f0-9]{64}', base)
revision = os.environ['GITHUB_SHA']
tag = repository + ':workspace-' + revision[:12] + '-' + os.environ['GITHUB_RUN_ID']
run('docker', 'pull', '--platform', 'linux/amd64', base)
run('docker', 'build', '--platform', 'linux/amd64', '--pull=false',
    '-f', 'deploy/agent-preview/Dockerfile.workspace',
    '--build-arg', 'RUNTIME_IMAGE=' + base,
    '--build-arg', 'WORKSPACE_REVISION=' + revision,
    '--label', 'org.opencontainers.image.source=https://github.com/' + os.environ['GITHUB_REPOSITORY'],
    '--label', 'org.opencontainers.image.revision=' + revision, '-t', tag, '.')
for name in ['tasks', 'server', 'fx-runtime']:
    run('docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node', tag,
        '--check', '/app/services/mpp-near-direct/p2/' + name + '.mjs')
run('docker', 'push', tag)
info = json.loads(subprocess.check_output(['docker', 'image', 'inspect', tag]))[0]
refs = [ref for ref in info['RepoDigests'] if ref.startswith(repository + '@sha256:')]
assert len(refs) == 1
result = {'sourceRevision': revision, 'workflowRunId': os.environ['GITHUB_RUN_ID'],
          'runtimeBase': base, 'images': {'agent-preview': refs[0]},
          'preLaunchScriptRequired': False, 'scope': 'controlled workspace reset; existing native runtime and data retained'}
Path('published-images.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
