# bot

This is a monorepo containing multiple services.

## Repository Structure

```
xp7kbot/
├── front/          # Flutter frontend
├── ai/             # AI chat backend (FastAPI + Ollama)
└── rag/            # RAG server (TON data RAG system) - TODO
```

## Services

### Frontend (`front/`)
- **Technology**: Flutter Web
- **Purpose**: Telegram Mini App UI
- **Deployment**: Railway (configured in `front/railway.json`)

### AI Service (`ai/`)
- **Technology**: FastAPI + Ollama
- **Purpose**: AI chat API
- **Deployment**: Railway (configured in `ai/railway.json`)
- **Status**: ✅ Active (merged from train branch)

### RAG Server (`rag/`)
- **Technology**: FastAPI + Vector DB + TON SDK
- **Purpose**: RAG system for TON blockchain data
- **Status**: To be created

## Development

### Frontend Development

Navigate to the frontend directory:
```bash
cd front
```

Then follow the instructions in `front/README.md` for Flutter development.

### Adding New Services

1. Create a new directory (e.g., `backend/`, `rag/`)
2. Add service-specific `railway.json` in that directory
3. Update root `railway.json` to include the new service

## Railway Deployment

This monorepo is configured for Railway deployment with multiple services:

- **Root `railway.json`**: Defines all services and their source directories
- **Service `railway.json`**: Service-specific configuration (in each service directory)

Railway will automatically detect and deploy all services defined in the root configuration.

## Getting Started

1. Clone the repository
2. Navigate to the service you want to work on (e.g., `cd front`)
3. Follow service-specific setup instructions
