@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  连小理 · 班费透明工作流  —— 推送到 GitHub
echo ============================================
echo.
echo 先在 GitHub 网页上新建一个**空仓库**（不要勾选 README / .gitignore / License）。
echo.
set /p URL=粘贴仓库地址（形如 https://github.com/你的用户名/lianxiaoli-ledger.git ：
echo.
git remote remove origin >nul 2>&1
git remote add origin %URL%
git branch -M main
echo 正在推送（如弹窗请登录 GitHub）...
git push -u origin main
echo.
if %errorlevel%==0 (
  echo 推送成功。
) else (
  echo 推送未完成：多半是没登录，或仓库不是空的（先用空仓库）。
)
pause
