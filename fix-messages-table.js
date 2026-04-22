const { Client } = require('pg');

async function fixMessagesTable() {
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

    // Drop lowercase messages table if it exists
    try {
      await client.query('DROP TABLE IF EXISTS "messages";');
      console.log('Dropped lowercase messages table');
    } catch (error) {
      console.log('No lowercase messages table to drop');
    }

    // Create uppercase Messages table
    console.log('Creating uppercase Messages table...');
    await client.query(`
      CREATE TABLE "Messages" (
        id SERIAL PRIMARY KEY,
        "chatId" INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        "senderId" INTEGER NOT NULL REFERENCES "Users"(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        "messageType" VARCHAR(10) DEFAULT 'text' CHECK ("messageType" IN ('text', 'image', 'file', 'voice')),
        "mediaUrl" VARCHAR(255),
        "replyToId" INTEGER REFERENCES "Messages"(id) ON DELETE SET NULL,
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
    await client.query(`CREATE INDEX "Messages_chatId_idx" ON "Messages"("chatId");`);
    await client.query(`CREATE INDEX "Messages_senderId_idx" ON "Messages"("senderId");`);
    await client.query(`CREATE INDEX "Messages_createdAt_idx" ON "Messages"("createdAt");`);

    console.log('Uppercase Messages table created successfully!');

    // Check if settings table exists with correct case
    const settingsResult = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'settings'
      );
    `);
    
    if (!settingsResult.rows[0].exists) {
      console.log('Creating settings table...');
      await client.query(`
        CREATE TABLE "settings" (
          id SERIAL PRIMARY KEY,
          "userId" INTEGER NOT NULL REFERENCES "Users"(id) ON DELETE CASCADE,
          key VARCHAR(255) NOT NULL,
          value JSONB NOT NULL DEFAULT '{}',
          category VARCHAR(100) DEFAULT 'general',
          "isPublic" BOOLEAN DEFAULT false,
          "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE("userId", key)
        );
      `);
      
      await client.query(`CREATE INDEX "settings_userId_idx" ON "settings"("userId");`);
      await client.query(`CREATE INDEX "settings_key_idx" ON "settings"(key);`);
      await client.query(`CREATE INDEX "settings_userId_key_idx" ON "settings"("userId", "key");`);
      
      console.log('Settings table created successfully!');
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
}

fixMessagesTable();
