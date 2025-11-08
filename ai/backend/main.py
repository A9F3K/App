from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import httpx
import os
import json

app = FastAPI()

# CORS middleware to allow Flutter app to call this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify your Flutter app domain
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Ollama API URL - defaults to localhost, can be overridden with env var
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
# Using tinyllama as default - smaller model that works on Railway free tier
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "tinyllama")


class ChatRequest(BaseModel):
    message: str


class ChatResponse(BaseModel):
    response: str


@app.get("/")
async def root():
    return {"status": "ok", "message": "AI Chat API is running"}


@app.post("/api/chat")
async def chat(request: ChatRequest):
    """
    Send a message to Ollama and return the AI response (streaming to avoid timeouts)
    """
    if not request.message or not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    
    async def generate_response():
        try:
            # Call Ollama API with streaming enabled
            async with httpx.AsyncClient(timeout=60.0) as client:
                async with client.stream(
                    "POST",
                    f"{OLLAMA_URL}/api/generate",
                    json={
                        "model": OLLAMA_MODEL,
                        "prompt": request.message,
                        "stream": True,  # Enable streaming
                        "options": {
                            "num_predict": 1000,  # Allow longer responses (increased from 100)
                            "temperature": 0.7,
                            "num_thread": 2,
                        }
                    }
                ) as response:
                    if response.status_code != 200:
                        error_detail = "Unknown error"
                        try:
                            error_text = await response.aread()
                            error_data = json.loads(error_text)
                            error_detail = error_data.get("error", str(error_text))
                        except:
                            error_detail = str(response.status_code)
                        
                        yield json.dumps({"error": f"Ollama error: {error_detail}"}) + "\n"
                        return
                    
                    full_response = ""
                    async for line in response.aiter_lines():
                        if line:
                            try:
                                data = json.loads(line)
                                if "response" in data:
                                    token = data["response"]
                                    full_response += token
                                    # Send each token as it's generated
                                    yield json.dumps({"token": token, "done": data.get("done", False)}) + "\n"
                                
                                if data.get("done", False):
                                    # Send final complete response
                                    yield json.dumps({"response": full_response, "done": True}) + "\n"
                                    break
                            except json.JSONDecodeError:
                                continue
        
        except httpx.TimeoutException:
            yield json.dumps({"error": "Request timeout - AI model took too long to respond"}) + "\n"
        except httpx.RequestError as e:
            yield json.dumps({"error": f"Cannot connect to Ollama at {OLLAMA_URL}. Error: {str(e)}"}) + "\n"
        except Exception as e:
            yield json.dumps({"error": f"Internal server error: {str(e)}"}) + "\n"
    
    return StreamingResponse(generate_response(), media_type="application/x-ndjson")


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)

