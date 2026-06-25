$ErrorActionPreference = 'Stop'
$root = 'C:\Users\Administrator\babylon-3dgs-demo-copy'
$out = Join-Path $root 'push-log.txt'
Set-Location $root

function Log($msg) {
  $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
  Add-Content -Path $out -Value $line
  Write-Output $line
}

if (Test-Path $out) { Remove-Item $out -Force }

try {
  Log '=== git status ==='
  & git status 2>&1 | ForEach-Object { Log $_ }

  Log '=== git log -1 ==='
  & git log -1 --oneline 2>&1 | ForEach-Object { Log $_ }

  Log '=== gh auth status ==='
  & gh auth status 2>&1 | ForEach-Object { Log $_ }

  Log '=== git remote -v (before) ==='
  & git remote -v 2>&1 | ForEach-Object { Log $_ }

  $remote = & git remote 2>&1
  if (-not $remote) {
    Log '=== gh repo create ==='
    & gh repo create babylon-3dgs-demo-copy --private --source=. --remote=origin --push 2>&1 | ForEach-Object { Log $_ }
  } else {
    Log '=== git push ==='
    & git push -u origin master 2>&1 | ForEach-Object { Log $_ }
  }

  Log '=== git remote -v (after) ==='
  & git remote -v 2>&1 | ForEach-Object { Log $_ }

  Log '=== gh repo view ==='
  & gh repo view --json url,visibility,defaultBranchRef 2>&1 | ForEach-Object { Log $_ }

  Log 'DONE'
} catch {
  Log "ERROR: $_"
  exit 1
}
