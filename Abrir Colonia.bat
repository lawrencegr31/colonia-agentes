@echo off
title Colonia de Agentes (no cierres esta ventana)
cd /d "%~dp0"
where node >nul 2>nul || (echo No encontre Node.js. Instalalo desde nodejs.org y vuelve a intentar. & pause & exit /b)
node iniciar.js
pause
