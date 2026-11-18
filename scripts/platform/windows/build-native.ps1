[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputRoot,[ValidateSet('win-x64','win-arm64')][string]$Runtime='win-x64')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){throw 'WINDOWS_ONLY'}
$destination=[IO.Path]::GetFullPath($OutputRoot)
if(Test-Path $destination){throw 'OUTPUT_MUST_BE_NEW'}
New-Item -ItemType Directory -Path $destination | Out-Null
$env:DOTNET_CLI_HOME=Join-Path $destination 'cli-home'
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE='false'
$env:DOTNET_ADD_GLOBAL_TOOLS_TO_PATH='false'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'
$env:DOTNET_NOLOGO='1'
$env:NUGET_PACKAGES=Join-Path $destination 'packages'
$probeSource=Join-Path $destination 'probe-source.cs'
& node (Join-Path $PSScriptRoot 'generate-probe.mjs') $probeSource
if($LASTEXITCODE -ne 0){throw 'GENERATE_FAILED'}
& dotnet publish (Join-Path $PSScriptRoot 'native/OwnedNodeJob.csproj') -c Release -r $Runtime --self-contained false -p:UseAppHost=true -p:PublishSingleFile=true -p:DebugType=embedded -p:IncludeAllContentForSelfExtract=false "-p:BaseIntermediateOutputPath=$destination/owned-obj/" "-p:MSBuildProjectExtensionsPath=$destination/owned-obj/" "-p:OutputPath=$destination/owned-build/" -o (Join-Path $destination 'owned')
if($LASTEXITCODE -ne 0){throw 'OWNED_BUILD_FAILED'}
& dotnet publish (Join-Path $PSScriptRoot 'native/PrivateRootProbe.csproj') -c Release -r $Runtime --self-contained false -p:UseAppHost=true -p:PublishSingleFile=true -p:DebugType=embedded -p:IncludeAllContentForSelfExtract=false "-p:ProbeSource=$probeSource" "-p:BaseIntermediateOutputPath=$destination/probe-obj/" "-p:MSBuildProjectExtensionsPath=$destination/probe-obj/" "-p:OutputPath=$destination/probe-build/" -o (Join-Path $destination 'probe')
if($LASTEXITCODE -ne 0){throw 'PROBE_BUILD_FAILED'}
# Only the EXE is hash-pinned by the native caller. All application assemblies
# must therefore be embedded, not supplied by a mutable sibling DLL. The shared
# system .NET runtime remains an explicit prerequisite (not bundled here).
foreach($helper in @(@{Directory='owned';Name='OwnedNodeJob.exe'},@{Directory='probe';Name='PrivateRootProbe.exe'})){
  $published=Join-Path $destination $helper.Directory
  $files=@(Get-ChildItem -LiteralPath $published -File -Recurse)
  if($files.Count -ne 1 -or $files[0].Name -cne $helper.Name){throw 'HELPER_PACKAGE_NOT_SINGLE_FILE'}
  Get-FileHash -LiteralPath $files[0].FullName -Algorithm SHA256
}
Write-Output 'BUILD_ONLY; single-file app assemblies; shared .NET runtime prerequisite; Windows behavior and physical acceptance NOT_RUN'
