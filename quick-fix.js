const { Client } = require('pg');

async function createMessagesTable() {
  const client = new Client({
    host: 'dpg-d7k8hrl7vvec73969alg-a.virginia-postgres.render.com',
    port: 5432,
    database: 'moodchat',
    user: 'moodchat_user',
    password: '5CzyEV3lQZNgKruwJHOzA7bw8q6T72xD',
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Connected to database');

    // Check if Messages table exists
    const result = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'messages'
      );
    `);
    
    if (result.rows[0].exists) {
      console.log('Messages table already exists');
      return;
    }

    console.log('Creating Messages table...');
    await client.query(`
      CREATE TABLE "messages" (
        id SERIAL PRIMARY KEY,
        "chatId" INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        "senderId" INTEGER NOT NULL REFERENCES "Users"(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        "messageType" VARCHAR(10) DEFAULT 'text' CHECK ("messageType" IN ('text', 'image', 'file', 'voice')),
        "mediaUrl" VARCHAR(255),
        "replyToId" INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        "isEdited" BOOLEAN DEFAULT false,
        "editedAt" TIMESTAMP,
        "isDeleted" BOOLEAN DEFAULT false,
        "deletedAt" TIMESTAMP,
        "readBy" JSONB DEFAULT '[]',
        reactions JSONB DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add indexes
    await client.query(`CREATE INDEX "messages_chatId_idx" ON "messages"("chatId");`);
    await client.query(`CREATE INDEX "messages_senderId_idx" ON "messages"("senderId");`);
    await client.query(`CREATE INDEX "messages_createdAt_idx" ON "messages"("createdAt");`);

    console.log('Messages table created successfully!');

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
}

createMessagesTable();
