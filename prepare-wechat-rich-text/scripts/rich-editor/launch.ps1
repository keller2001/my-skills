param([string]$ArticlePath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$exitCode = 1

try {
  if ([string]::IsNullOrWhiteSpace($ArticlePath)) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = [System.Windows.Forms.OpenFileDialog]::new()
    $dialog.Title = '选择文件名为 article.md 的文章'
    $dialog.Filter = 'article.md|article.md'
    $dialog.CheckFileExists = $true
    $dialog.Multiselect = $false
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
    $ArticlePath = $dialog.FileName
  }

  $resolved = [System.IO.Path]::GetFullPath($ArticlePath)
  if ([System.IO.Path]::GetFileName($resolved) -cne 'article.md') {
    throw '选中的文件必须严格命名为 article.md。'
  }
  if (-not [System.IO.File]::Exists($resolved)) { throw '找不到选中的 article.md。' }

  $node = (Get-Command node.exe -ErrorAction Stop).Source
  & $node (Join-Path $PSScriptRoot 'server.mjs') --article $resolved --open
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { throw "编辑器退出，错误码：$exitCode" }
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '公众号富文本编辑器', 'OK', 'Error') | Out-Null
  exit $exitCode
}
