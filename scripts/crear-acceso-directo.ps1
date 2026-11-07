<#
  Crea el acceso directo "Reportar a Sistemas" en el escritorio.
  Abre Reports en una ventana propia (modo app de Edge o Chrome) y manda el nombre del equipo.

  Uso (en cada PC, o por GPO / script de inicio de sesión):
    powershell -ExecutionPolicy Bypass -File crear-acceso-directo.ps1 -Servidor "http://192.168.1.10:3000"

  Con -TodosLosUsuarios (requiere administrador) lo pone en el escritorio público.
#>
param(
  [Parameter(Mandatory = $true)][string]$Servidor,
  [string]$Nombre = "Reportar a Sistemas",
  [switch]$TodosLosUsuarios
)

$ErrorActionPreference = "Stop"
$url = $Servidor.TrimEnd("/") + "/?equipo=" + [uri]::EscapeDataString($env:COMPUTERNAME)

$navegadores = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$navegador = $navegadores | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($TodosLosUsuarios) { $escritorio = [Environment]::GetFolderPath("CommonDesktopDirectory") }
else { $escritorio = [Environment]::GetFolderPath("Desktop") }
$destino = Join-Path $escritorio ($Nombre + ".lnk")

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($destino)
if ($navegador) {
  $lnk.TargetPath = $navegador
  $lnk.Arguments = "--app=`"$url`" --window-size=640,860"
  $lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,23"
} else {
  # Sin Edge/Chrome: abre en el navegador predeterminado.
  $lnk.TargetPath = $url
}
$lnk.Description = "Reports · Grupo Volcanes — reporta un problema a Sistemas"
$lnk.Save()

Write-Host "Acceso directo creado: $destino"
Write-Host "Abre: $url"
