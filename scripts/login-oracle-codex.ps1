param(
    [string]$HostAddress = '161.33.192.81',
    [string]$IdentityFile = (Join-Path $env:USERPROFILE '.ssh\roam-oracle-20261014.key')
)

$ErrorActionPreference = 'Stop'
if ($HostAddress -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]*$') { throw 'Invalid SSH host.' }
if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) { throw 'SSH private key not found.' }

# Run in the user's terminal so the one-time sign-in code stays out of chat logs.
$remoteLogin = 'umask 077; export PATH="$HOME/.local/lib/node-v24.18.0-linux-x64/bin:$HOME/.local/bin:$PATH"; codex login --device-auth && codex login status'
& ssh -t -i $IdentityFile -o StrictHostKeyChecking=yes "ubuntu@$HostAddress" $remoteLogin
exit $LASTEXITCODE
