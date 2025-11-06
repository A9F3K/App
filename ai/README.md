# Telegram Mini App - Flutter

A simple one-page Telegram Mini App built with Flutter that displays "Hello" text.

## Setup

### Prerequisites

1. **Install Flutter** if you haven't already:

   **Option A: Automated Setup (Recommended)**
   ```bash
   bash setup_flutter.sh
   ```
   This script will guide you through downloading Flutter and configuring your PATH.

   **Option B: Manual Installation**
   - Download from: https://flutter.dev/docs/get-started/install/windows
   - Extract to a location (e.g., `C:\src\flutter`)
   - Add Flutter to your PATH:
     - **For Git Bash**: Add this to your `~/.bashrc`:
       ```bash
       export PATH="$PATH:/c/src/flutter/bin"
       ```
     - **For Windows**: Add `C:\src\flutter\bin` to your System PATH
   - Verify installation:
     ```bash
     flutter --version
     ```

2. **Install Vercel CLI** (for deployment):
   ```bash
   npm i -g vercel
   ```

### Getting Started

1. Get dependencies:
   ```bash
   flutter pub get
   ```

2. Run the app in development mode:

   **Quick Dev (Git Bash / Mac / Linux):**
   ```bash
   bash dev.sh
   ```

   **Quick Dev (Windows Command Prompt / PowerShell):**
   ```cmd
   dev.bat
   ```

   **Manual Dev:**
   ```bash
   flutter run -d chrome
   ```

   **Development Options:**
   - `flutter run -d chrome` - Run in Chrome (auto-selects available port)
   - `flutter run -d edge` - Run in Edge
   - `flutter run -d chrome --web-port 8080` - Run on specific port (if available)
   - `flutter run -d chrome --devtools` - Run with DevTools

   **Hot Reload Commands (while running):**
   - Press `r` - Hot reload (apply changes instantly)
   - Press `R` - Hot restart (full restart)
   - Press `q` - Quit

   **Auto Hot Reload on Save (VS Code/Cursor):**
   - The project includes `.vscode/settings.json` with auto hot reload enabled
   - **To enable auto hot reload:**
     1. Make sure you have the **Flutter extension** installed in Cursor/VS Code
     2. **Run the app from Cursor** (F5 or use Run menu → "Flutter (Chrome)")
     3. Or if running from terminal, make sure Cursor is connected to the debug session
     4. Save your file (Ctrl+S / Cmd+S) - it should auto-reload
   - **If auto-reload doesn't work:**
     - Make sure the app is running in debug mode (not release mode)
     - Try manually pressing `r` in the terminal where Flutter is running
     - Or use the Flutter extension's "Hot Reload" button in Cursor
     - Check that `dart.flutterHotReloadOnSave` is set to `"always"` in settings

## Building for Telegram

To build the web version for Telegram Mini App:

```bash
flutter build web --release
```

The built files will be in the `build/web` directory. You can deploy these files to a web server and set the URL in your Telegram Bot configuration.

## Deploying to Vercel

This project is configured for easy deployment on Vercel. Here are the deployment options:

### Option 1: Deploy with Vercel CLI (Easiest)

**Quick Deploy (Git Bash / Mac / Linux):**
```bash
bash deploy.sh
```

Or if you've made it executable:
```bash
./deploy.sh
```

**Quick Deploy (Windows Command Prompt / PowerShell):**
```cmd
deploy.bat
```

**Manual Deploy:**

1. Install Vercel CLI if you haven't already:
   ```bash
   npm i -g vercel
   ```

2. Build the Flutter web app:
   ```bash
   flutter build web --release
   ```

3. Copy vercel.json to build directory and deploy:
   ```bash
   copy vercel.json build\web\vercel.json  # Windows
   # OR
   cp vercel.json build/web/vercel.json    # Mac/Linux
   
   cd build/web
   vercel --prod
   ```

### Option 2: Deploy via Vercel Dashboard

1. Build the Flutter web app:
   ```bash
   flutter build web --release
   ```

2. Go to [Vercel Dashboard](https://vercel.com/dashboard)

3. Click "Add New..." → "Project"

4. Either:
   - **Drag and drop** the `build/web` folder, or
   - **Import Git Repository** (if you've pushed to GitHub/GitLab)

5. If importing from Git, set:
   - **Root Directory**: `build/web` (or deploy the whole repo and configure accordingly)
   - Vercel will automatically detect the `vercel.json` configuration

### Option 3: Automated Deployment with GitHub Actions

1. Push your code to GitHub

2. Set up Vercel secrets in GitHub:
   - Go to your GitHub repository → Settings → Secrets and variables → Actions
   - Add these secrets:
     - `VERCEL_TOKEN`: Get from [Vercel Account Settings](https://vercel.com/account/tokens)
     - `VERCEL_ORG_ID`: Get from Vercel dashboard
     - `VERCEL_PROJECT_ID`: Get from Vercel dashboard

3. Connect repository to Vercel (optional, for dashboard visibility):
   - Go to [Vercel Dashboard](https://vercel.com/dashboard)
   - Import your GitHub repository

4. The GitHub Action will automatically build and deploy on every push to `main` or `master`

**Note:** Since Vercel doesn't have Flutter pre-installed in their build environment, you need to build the Flutter app first. The GitHub Actions workflow handles this automatically.

## Notes

- This app is designed to run in Telegram's webview
- The Telegram Web App SDK script is included in `web/index.html`
- The app automatically expands to fill the screen when loaded in Telegram
- The `vercel.json` configuration handles routing for the Flutter SPA

