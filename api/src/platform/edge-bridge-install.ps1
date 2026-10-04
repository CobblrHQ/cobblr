param([string]$Code, [switch]$Uninstall, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
$CobblrUrl = '@@COBBLR_URL@@'
$Root = Join-Path $env:LOCALAPPDATA 'Cobblr\bridge'
$Binary = Join-Path $Root 'cobblr-edge-bridge.exe'
$TaskName = 'Cobblr Edge Bridge'
$Download = "$CobblrUrl/api/v1/desktop/bridge/windows/x64"
if ($DryRun) {
    @{ directory = $Root; binary = $Binary; download = $Download; task = $TaskName; runLevel = 0; logonType = 3; trigger = 'current-user-logon'; administrator = $false; pairing = "& `"$Binary`" pair-lightburn 127.0.0.1"; uninstall = '-Uninstall' } | ConvertTo-Json
    return
}
$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$TaskName = "Cobblr Edge Bridge-$($Identity.User.Value)"
$Scheduler = New-Object -ComObject 'Schedule.Service'
$Scheduler.Connect()
$Folder = $Scheduler.GetFolder('\')
if ($Uninstall -or $Code -eq 'uninstall') {
    try { $Folder.GetTask($TaskName).Stop(0) } catch { }
    try { $Folder.DeleteTask($TaskName, 0) } catch { }
    Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $Binary } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
    if (Test-Path $Root) { Remove-Item $Root -Recurse -Force }
    Write-Output 'Bridge removed. Disconnect it in Cobblr to revoke its key. LightBurn pairing is retained.'
    return
}
if ($Code -notmatch '^[A-Z0-9-]{6,32}$') { throw 'Give the install code shown in Cobblr.' }
$Pair = Invoke-RestMethod -Uri "$CobblrUrl/api/v1/edge/pair" -Method Post -ContentType 'application/json' -Body (@{ code = $Code } | ConvertTo-Json -Compress)
if (-not $Pair.token -or -not $Pair.relay_path) { throw 'Cobblr did not return a bridge key. Get a new install code.' }
New-Item -ItemType Directory -Path $Root -Force | Out-Null
$Acl = New-Object System.Security.AccessControl.DirectorySecurity
$Acl.SetOwner($Identity.User)
$Acl.SetAccessRuleProtection($true, $false)
$Rule = New-Object System.Security.AccessControl.FileSystemAccessRule($Identity.User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$Acl.AddAccessRule($Rule)
Set-Acl -Path $Root -AclObject $Acl
Invoke-WebRequest -UseBasicParsing -Uri $Download -OutFile "$Binary.tmp"
if ((Get-Item "$Binary.tmp").Length -eq 0) { throw 'The bridge download was empty.' }
Move-Item "$Binary.tmp" $Binary -Force
@{ relay = "$CobblrUrl$($Pair.relay_path)"; token = $Pair.token; bridge = $Pair.bridge; name = $Pair.name } | ConvertTo-Json | Set-Content (Join-Path $Root 'bridge.json') -Encoding UTF8
@'
$ErrorActionPreference = 'Stop'
$Config = Get-Content (Join-Path $PSScriptRoot 'bridge.json') -Raw | ConvertFrom-Json
$env:BRIDGE_MODE = 'tunnel'
$env:BRIDGE_RELAY_URL = $Config.relay
$env:BRIDGE_RELAY_TOKEN = $Config.token
$env:BRIDGE_ID = $Config.bridge
$env:BRIDGE_HOST_NAME = $Config.name
$env:BRIDGE_CACHE_DIR = Join-Path $PSScriptRoot 'cache'
while ($true) {
    & (Join-Path $PSScriptRoot 'cobblr-edge-bridge.exe')
    Start-Sleep -Seconds 3
}
'@ | Set-Content (Join-Path $Root 'run.ps1') -Encoding UTF8
$Task = $Scheduler.NewTask(0)
$Task.RegistrationInfo.Description = 'Connect local machines to your Cobblr workspace.'
$Task.Principal.UserId = $Identity.Name
$Task.Principal.LogonType = 3
$Task.Principal.RunLevel = 0
$Task.Settings.Enabled = $true
$Task.Settings.StartWhenAvailable = $true
$Task.Settings.DisallowStartIfOnBatteries = $false
$Task.Settings.StopIfGoingOnBatteries = $false
$Task.Settings.ExecutionTimeLimit = 'PT0S'
$Trigger = $Task.Triggers.Create(9)
$Trigger.UserId = $Identity.Name
$Action = $Task.Actions.Create(0)
$Action.Path = Join-Path $PSHOME 'powershell.exe'
$Action.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $Root 'run.ps1')`""
$Action.WorkingDirectory = $Root
$Registered = $Folder.RegisterTaskDefinition($TaskName, $Task, 6, $Identity.Name, $null, 3)
$Registered.Run($null) | Out-Null
Write-Output 'Bridge installed for your user. It starts when you sign in, with no administrator access.'
Write-Output "Pair LightBurn: & `"$Binary`" pair-lightburn 127.0.0.1"
