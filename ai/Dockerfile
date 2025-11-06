FROM python:3.11-slim

WORKDIR /app

# Copy requirements and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY backend/ ./backend/

# Expose port (Railway sets PORT env var)
EXPOSE 8000

# Run the application using PORT from environment
CMD ["sh", "-c", "cd backend && python -m uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]

