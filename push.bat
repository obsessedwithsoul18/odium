@echo off
rem ---------------------------------------------------------------------------
rem Build the site, commit everything, sync with GitHub, push.
rem
rem   push.bat
rem   push.bat "message for this update"
rem
rem Handles the three ways a push normally dies:
rem   - working tree clean but local commits never pushed
rem   - GitHub moved ahead (edits made in the browser)  -> merges first
rem   - a real error                                      -> prints it, exits 1
rem ---------------------------------------------------------------------------

setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist ".git\" (
  echo [x] No git repo in "%CD%"
  exit /b 1
)

rem ---------- 1. build dist\ ----------
if exist "scripts\build-pages.mjs" (
  set "BUILDLOG=%TEMP%\retrac-build-%RANDOM%.log"
  echo Building dist\ ...
  node "scripts\build-pages.mjs" >"!BUILDLOG!" 2>&1
  if errorlevel 1 (
    type "!BUILDLOG!"
    del "!BUILDLOG!" >nul 2>&1
    echo [x] dist build failed - run: node scripts\build-pages.mjs
    exit /b 1
  )
  del "!BUILDLOG!" >nul 2>&1
)

rem ---------- 2. stage ----------
git add -A
if errorlevel 1 (
  echo [x] git add failed - is another git process running? delete .git\index.lock
  exit /b 1
)

set "COUNT=0"
for /f "delims=" %%L in ('git status --porcelain') do set /a COUNT+=1

if not "%COUNT%"=="0" (
  set "MSG=%*"
  if "!MSG:~0,1!"=="\"" set "MSG=!MSG:~1,-1!"
  if "!MSG!"=="" set "MSG=update %COUNT% file(s) %DATE% %TIME%"
  echo Committing %COUNT% change^(s^) ...
  git commit -q -m "!MSG!"
  if errorlevel 1 (
    echo [x] Commit failed.
    exit /b 1
  )
)

rem ---------- 3. sync with GitHub ----------
echo Checking GitHub ...
git fetch origin --quiet
if errorlevel 1 (
  echo [x] Cannot reach GitHub. Check the network or your credentials.
  exit /b 1
)

set "AHEAD=0"
for /f %%N in ('git rev-list --count "@{upstream}..HEAD" 2^>nul') do set "AHEAD=%%N"
set "BEHIND=0"
for /f %%N in ('git rev-list --count "HEAD..@{upstream}" 2^>nul') do set "BEHIND=%%N"

if "%BEHIND%"=="0" goto push

echo GitHub is %BEHIND% commit^(s^) ahead - merging before push ...
git merge --no-edit -X ours "@{upstream}"
if errorlevel 1 (
  echo.
  echo [x] Merge needs a human. Conflicting files:
  git diff --name-only --diff-filter=U
  echo.
  echo Fix them, run: git add -A  then  push.bat
  exit /b 1
)

:push
if "%AHEAD%%BEHIND%%COUNT%"=="000" (
  echo Nothing to push - GitHub already matches this folder.
  exit /b 0
)

echo Pushing ...
git push
if errorlevel 1 (
  echo.
  echo [x] Push rejected. Most common cause: GitHub moved again.
  echo     Delete .git\index.lock if it exists, then run push.bat once more.
  exit /b 1
)

echo.
git log --oneline -1
echo Pushed %COUNT% file^(s^).
exit /b 0
