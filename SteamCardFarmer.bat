@echo off
setlocal
cd /d "%~dp0"
title Steam Card Farmer (Sunucu ve Log Ekrani)
color 0A

:: Node.js var mi kontrol et
node -v >nul 2>&1
if %errorlevel% neq 0 (
    color 0E
    echo ===================================================
    echo SISTEMDE NODE.JS BULUNAMADI!
    echo ===================================================
    echo Steam Card Farmer'in calisabilmesi icin Node.js gereklidir.
    echo Otomatik olarak indirip kurmak ister misiniz?
    echo.
    set /p "installNode=Evet icin (E) veya (Y), Hayir icin (H) veya (N) tuslayin: "
    if /i "%installNode%"=="e" goto InstallNode
    if /i "%installNode%"=="y" goto InstallNode
    echo.
    echo Node.js kurulmadigi icin program baslatilamiyor.
    pause
    exit /b
)

:: Node.js var ise direkt gec
goto StartApp

:InstallNode
echo.
echo Lutfen bekleyin, Node.js son LTS surumu indiriliyor...
powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi' -OutFile '%TEMP%\nodejs_install.msi'"
if exist "%TEMP%\nodejs_install.msi" (
    echo Indirme tamamlandi. Kurulum yapiliyor... Lutfen cikan ekranda 'Next' diyerek kurun. Veya sessiz kurulum icin bekleyin.
    :: Sessiz kurulum:
    msiexec /i "%TEMP%\nodejs_install.msi" /quiet /qn /norestart
    echo Kurulum tamamlandi.
    
    :: Yeni kurulan node komutunun aninda CMD'de algilanmasi icin Windows ortam degiskenini yeniliyoruz:
    set "PATH=%PATH%;C:\Program Files\nodejs\"
    
    :: Node calisiyor mu tekrar test et
    node -v >nul 2>&1
    if %errorlevel% neq 0 (
        color 0C
        echo.
        echo SORUN: Node.js kuruldu fakat algilanamadi. Lutfen pencereyi kapatip programi tekrar acin.
        pause
        exit /b
    )
) else (
    color 0C
    echo INDIRME BASARISIZ! Lutfen nodejs.org adresinden manuel olarak kurun.
    pause
    exit /b
)

:StartApp
if not exist "node_modules\" (
    color 0E
    echo.
    echo ===================================================
    echo ILK KURULUM: Gerekli kutuphaneler yukleniyor...
    echo Lutfen bitene kadar bekleyin...
    echo ===================================================
    call npm install
)

color 0A
echo ===================================================
echo Steam Card Farmer Baslatiliyor...
echo Bu pencereyi kapatirsaniz program kapanir!
echo Lutfen acilana kadar bekleyin.
echo ===================================================

node server.js
pause
