const { Client } = require('pg');

async function fixFeaturesForeignKey() {
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

    // Drop the problematic foreign key if it exists
    try {
      await client.query(`ALTER TABLE "features" DROP CONSTRAINT IF EXISTS "features_created_by_fkey";`);
      console.log('Dropped existing foreign key constraint');
    } catch (error) {
      console.log('No foreign key constraint to drop');
    }

    // Recreate the foreign key constraint
    await client.query(`
      ALTER TABLE "features" 
      ADD CONSTRAINT "features_created_by_fkey" 
      FOREIGN KEY ("created_by") REFERENCES "Users"("id") 
      ON DELETE SET NULL ON UPDATE CASCADE
    `);
    console.log('Foreign key constraint created successfully!');

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
}

fixFeaturesForeignKey();
