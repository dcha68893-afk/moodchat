const { Client } = require('pg');

async function fixFeaturesTable() {
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

    // Check if created_by column exists in features table
    const columnResult = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'features' 
      AND column_name = 'created_by'
    `);
    
    if (columnResult.rows.length === 0) {
      console.log('Adding missing created_by column to features table...');
      await client.query(`
        ALTER TABLE "features" 
        ADD COLUMN "created_by" INTEGER REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE
      `);
      console.log('created_by column added successfully!');
    } else {
      console.log('created_by column already exists');
    }

    console.log('Features table fixed successfully!');

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
}

fixFeaturesTable();
