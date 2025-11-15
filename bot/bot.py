import os
import asyncio
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes
from telegram.error import Conflict

load_dotenv()


async def hello(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(f'Hello {update.effective_user.first_name}')


async def post_init(app):
    """Delete webhook before starting polling to avoid conflicts"""
    try:
        await app.bot.delete_webhook(drop_pending_updates=True)
        print("Webhook deleted (if it existed)")
        # Small delay to ensure webhook deletion is processed
        await asyncio.sleep(1)
    except Exception as e:
        print(f"Note: Could not delete webhook: {e}")


def main():
    token = os.getenv('token')
    if not token:
        raise ValueError("Environment variable 'token' is not set")
    
    app = ApplicationBuilder().token(token).post_init(post_init).build()
    app.add_handler(CommandHandler("start", hello))
    
    print("Bot starting...")
    try:
        app.run_polling(drop_pending_updates=True, allowed_updates=Update.ALL_TYPES)
    except Conflict:
        print("Error: Another bot instance is already running or webhook conflict exists.")
        print("This usually resolves automatically. If it persists, check for other running instances.")
    except KeyboardInterrupt:
        print("\nBot stopped by user")
    except Exception as e:
        print(f"Error: {e}")


if __name__ == '__main__':
    main()
