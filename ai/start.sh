#!/bin/bash

# Start Ollama in the background
echo "Starting Ollama server..."
/usr/local/bin/ollama serve > /tmp/ollama.log 2>&1 &
OLLAMA_PID=$!

# Wait for Ollama to be ready (check if it's responding)
echo "Waiting for Ollama to start..."
OLLAMA_READY=false
for i in {1..60}; do
    if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
        echo "Ollama is ready!"
        OLLAMA_READY=true
        break
    fi
    sleep 1
done

if [ "$OLLAMA_READY" = false ]; then
    echo "Warning: Ollama did not start in time, but continuing with FastAPI..."
    echo "Ollama logs:"
    cat /tmp/ollama.log || true
fi

# Check if model exists, if not pull it in background (don't block startup)
# Using tinyllama as default - much smaller and works on Railway free tier
MODEL=${OLLAMA_MODEL:-tinyllama}
echo "Checking for model: $MODEL"
if command -v ollama > /dev/null 2>&1; then
    if ! ollama list 2>/dev/null | grep -q "$MODEL"; then
        echo "Model $MODEL not found. Will pull in background (this may take a while, 2-7GB download)..."
        # Pull model in background so it doesn't block FastAPI startup
        (ollama pull $MODEL && echo "Model $MODEL pulled successfully!") || {
            echo "Warning: Failed to pull model. Chat requests will fail until model is available."
        } &
    else
        echo "Model $MODEL already exists"
    fi
else
    echo "Warning: ollama command not found in PATH"
fi

# Start FastAPI app (this is the main process)
echo "Starting FastAPI application on port ${PORT:-8000}..."
cd backend
exec python -m uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}

