@echo off
cd /d "%~dp0"
echo.
echo Detecting LAN IP for shareable meeting links...
for /f "usebackq delims=" %%i in (`python -c "from backend.config import detect_lan_ip, get_settings; get_settings.cache_clear(); print(detect_lan_ip())"`) do set LAN_IP=%%i
echo.
echo Starting Minuta on 0.0.0.0:8000 (LAN accessible)
echo   This PC:     http://127.0.0.1:8000
echo   Other device: http://%LAN_IP%:8000
echo   Share base:  uses MINUTA_BASE_URL from .env (auto = http://%LAN_IP%:8000)
echo.
echo IMPORTANT: Same Wi-Fi only. Production needs a public HTTPS domain.
echo If Device B cannot connect, allow Python through Windows Firewall on port 8000.
echo.
python -m uvicorn server:app --reload --host 0.0.0.0 --port 8000
pause
