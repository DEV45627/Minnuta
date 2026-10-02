@echo off
cd /d "%~dp0"
echo Installing Minuta dependencies...
python -m pip install -r requirements.txt
python -m spacy download en_core_web_sm
echo.
echo Setup complete.
echo Run: run.bat
echo Or:  python -m uvicorn server:app --reload --host 127.0.0.1 --port 8000
echo Open: http://127.0.0.1:8000
echo Demo: http://127.0.0.1:8000/demo
pause
