param(
  [Parameter(Mandatory = $true)][ValidateSet('check','probe','replace')][string]$Action,
  [Parameter(Mandatory = $true)][string]$ArticlePath,
  [string]$TargetPath,
  [string]$SourcePath,
  [string]$BackupPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Full([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

$article = Full $ArticlePath
if ([System.IO.Path]::GetFileName($article) -cne 'article.md') { throw 'The selected file must be named article.md.' }
$root = [System.IO.Path]::GetDirectoryName($article)
$images = Full ([System.IO.Path]::Combine($root, 'images'))

function Assert-Allowed([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Missing path.' }
  $full = Full $Path
  $insideImages = $full.StartsWith($images + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
  $isImages = $full.Equals($images, [System.StringComparison]::OrdinalIgnoreCase)
  if (-not ($full.Equals($article, [System.StringComparison]::OrdinalIgnoreCase) -or $isImages -or $insideImages)) {
    throw "Path is outside the article whitelist: $full"
  }

  if ([System.IO.File]::Exists($full)) {
    $fileAttrs = [System.IO.File]::GetAttributes($full)
    if (($fileAttrs -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point rejected: $full" }
  }
  $probe = if ([System.IO.Directory]::Exists($full)) { $full } else { [System.IO.Path]::GetDirectoryName($full) }
  while (-not [System.IO.Directory]::Exists($probe)) {
    $parent = [System.IO.Path]::GetDirectoryName($probe)
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $probe) { throw "Cannot resolve parent directory: $full" }
    $probe = $parent
  }
  while ($true) {
    $attrs = [System.IO.File]::GetAttributes($probe)
    if (($attrs -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point rejected: $probe" }
    $parent = [System.IO.Directory]::GetParent($probe)
    if ($null -eq $parent) { break }
    $probe = $parent.FullName
  }
  return $full
}

try {
  Assert-Allowed $article | Out-Null
  Assert-Allowed $images | Out-Null
  if ($Action -eq 'check') {
    Assert-Allowed $TargetPath | Out-Null
    [pscustomobject]@{ ok = $true; action = 'check' } | ConvertTo-Json -Compress
    exit 0
  }

  if ($Action -eq 'probe') {
    $recovery = Full ([System.IO.Path]::Combine($images, '.mpw-recovery'))
    $probeDir = Full ([System.IO.Path]::Combine($recovery, '.probe'))
    Assert-Allowed $probeDir | Out-Null
    [System.IO.Directory]::CreateDirectory($probeDir) | Out-Null
    $destination = [System.IO.Path]::Combine($probeDir, 'destination.txt')
    $source = [System.IO.Path]::Combine($probeDir, 'source.txt')
    $backup = [System.IO.Path]::Combine($probeDir, 'backup.txt')
    [System.IO.File]::WriteAllText($destination, 'old', [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($source, 'new', [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::Replace($source, $destination, $backup, $true)
    if ([System.IO.File]::ReadAllText($destination) -ne 'new' -or [System.IO.File]::ReadAllText($backup) -ne 'old') {
      throw 'File.Replace probe returned unexpected content.'
    }
    [System.IO.Directory]::Delete($probeDir, $true)
    [pscustomobject]@{ ok = $true; action = 'probe' } | ConvertTo-Json -Compress
    exit 0
  }

  $source = Assert-Allowed $SourcePath
  $target = Assert-Allowed $TargetPath
  $backup = Assert-Allowed $BackupPath
  if (-not [System.IO.File]::Exists($source)) { throw "Replace source does not exist: $source" }
  if (-not [System.IO.File]::Exists($target)) { throw "Replace target does not exist: $target" }
  [System.IO.File]::Replace($source, $target, $backup, $true)
  [pscustomobject]@{ ok = $true; action = 'replace' } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
