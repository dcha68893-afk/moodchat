# MoodChat Backend

A production-ready backend service for MoodChat application, providing RESTful APIs for real-time mood tracking and social interaction features.

## Features

- 🔐 **Authentication & Authorization** - JWT-based authentication with access/refresh tokens
- 👥 **User Management** - Complete user registration, profile management, and social features
- 😊 **Mood Tracking** - Users can log their moods with emotions, notes, and context
- 💬 **Social Interaction** - Friends system, mood sharing, and support messages
- 📊 **Analytics** - Mood trends, statistics, and insights
- 📁 **File Uploads** - Profile pictures and attachment support
- 🔔 **Notifications** - Real-time notifications for social interactions
- 📈 **Health Monitoring** - Built-in health checks and metrics
- 🐳 **Containerized** - Docker support for easy deployment

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Database**: PostgreSQL 15+
- **Cache**: Redis 7+
- **Authentication**: JWT with refresh token rotation
- **File Upload**: Multer with validation
- **Validation**: Joi/Validator.js
- **Logging**: Winston with file rotation
- **Testing**: Jest & Supertest
- **Container**: Docker & Docker Compose

## Prerequisites

- Node.js 18+ or Docker
- PostgreSQL 15+
- Redis 7+

## Quick Start with Docker

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd moodchat-backend