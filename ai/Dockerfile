FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for Ollama
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Ollama
RUN curl -fsSL https://ollama.com/install.sh | sh

# Copy requirements and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY backend/ ./backend/

# Copy start script
COPY start.sh ./
RUN chmod +x start.sh

# Expose ports
# 8000 for FastAPI, 11434 for Ollama (internal only)
EXPOSE 8000

# Run start script which starts both Ollama and FastAPI
CMD ["./start.sh"]

