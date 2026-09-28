param([string]$WorkspaceRoot = (Get-Location).Path)
$ErrorActionPreference = 'Stop'
$resolvedWorkspace = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $resolvedWorkspace 'lib/plugins/plugin.js'))) { throw '请从 Yunzai 工作区根目录执行' }
$storage = Join-Path $resolvedWorkspace 'data/elia-admin-panel'
$resolvedStorage = (Resolve-Path -LiteralPath $storage).Path
if ($resolvedStorage -ne [System.IO.Path]::GetFullPath($storage)) { throw '面板存储路径边界不匹配' }
if ((Get-Item -LiteralPath $resolvedStorage).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '面板存储目录不能是链接' }
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($currentSid)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagation = [System.Security.AccessControl.PropagationFlags]::None
foreach ($sid in @($currentSid, [System.Security.Principal.SecurityIdentifier]'S-1-5-32-544', [System.Security.Principal.SecurityIdentifier]'S-1-5-18')) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, $propagation, 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $resolvedStorage -AclObject $acl
Write-Output '面板存储 ACL 已收紧：仅当前账号、Administrators、SYSTEM；子项继承该权限'
