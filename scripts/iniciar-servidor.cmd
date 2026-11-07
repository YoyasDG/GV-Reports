@echo off
REM Inicia Reports en esta PC (servidor). Déjalo en el Programador de tareas "Al iniciar el sistema".
cd /d "%~dp0.."
node --no-warnings=ExperimentalWarning src\server.js
