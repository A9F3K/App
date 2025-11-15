# Telegram Bot

A simple Telegram bot that responds with "hello" to the `/start` command.

## Setup

### Local Development

1. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

2. **Create `.env` file:**
   ```bash
   cp .env.example .env
   ```

3. **Add your bot token to `.env`:**
   ```env
   token=your_actual_bot_token_here
   ```
   
   Get your token from [@BotFather](https://t.me/botfather) on Telegram.

4. **Run the bot:**
   ```bash
   python bot.py
   ```

### Railway Deployment

1. **Connect to Railway:**
   - Install Railway CLI: `npm i -g @railway/cli`
   - Login: `railway login`
   - Initialize: `railway init` (in the bot directory)
   - Or connect via Railway dashboard

2. **Add environment variable:**
   - Go to your Railway project settings
   - Navigate to "Variables" tab
   - Add `token` with your bot token value
   - Or use CLI: `railway variables set token=your_bot_token_here`

3. **Deploy:**
   - Push to your connected repo, or
   - Use CLI: `railway up`
   - Railway will automatically:
     - Detect `requirements.txt` and install dependencies
     - Use `railway.json` or `Procfile` to start the bot
     - Run `python bot.py` as the start command

4. **Check logs:**
   - View logs in Railway dashboard, or
   - Use CLI: `railway logs`

## How It Works

- **Local:** Uses `.env` file via `python-dotenv` to load `token`
- **Railway:** Uses environment variables set in Railway dashboard (`.env` file is ignored)
- The `load_dotenv()` function only loads from `.env` if the environment variable doesn't already exist, so Railway's environment variables take precedence

## Commands

- `/hello` - Bot responds with "Hello [your name]"

## Notes

- The `.env` file is gitignored to keep your token secure
- Never commit your actual `.env` file to version control
- Railway automatically sets environment variables, so no `.env` file is needed there

