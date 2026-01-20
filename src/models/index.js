// models/index.js (FIXED ASSOCIATIONS - UPDATED)
const { Sequelize } = require('sequelize');

// Database configuration
const env = process.env.NODE_ENV || 'development';

// Get database configuration based on environment
const getDbConfig = () => {
  // If DATABASE_URL is provided (Render, Heroku), use it
  if (process.env.DATABASE_URL) {
    console.log(`[Database] Using DATABASE_URL for ${env} environment`);
    return {
      url: process.env.DATABASE_URL,
      dialect: 'postgres',
      logging: process.env.NODE_ENV === 'development' ? console.log : false,
      pool: {
        max: 10,
        min: 0,
        acquire: 30000,
        idle: 10000
      },
      dialectOptions: process.env.DB_SSL === 'true' ? {
        ssl: {
          require: true,
          rejectUnauthorized: false,
        },
      } : {},
    };
  }
  
  // Otherwise use individual connection parameters
  console.log(`[Database] Using individual config for ${env} environment`);
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'moodchat',
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '24845c1b4df84c17a0526806f7aa0482',
    dialect: process.env.DB_DIALECT || 'postgres',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    dialectOptions: process.env.DB_SSL === 'true' ? {
      ssl: {
        require: true,
        rejectUnauthorized: false,
      },
    } : {},
  };
};

const dbConfig = getDbConfig();

// Initialize Sequelize instance
const sequelize = dbConfig.url
  ? new Sequelize(dbConfig.url, {
      dialect: dbConfig.dialect,
      logging: dbConfig.logging,
      pool: dbConfig.pool,
      dialectOptions: dbConfig.dialectOptions,
      define: {
        timestamps: true,
        underscored: true,
        freezeTableName: true, // CRITICAL: Prevents table name pluralization
        paranoid: false,
      },
    })
  : new Sequelize(dbConfig.database, dbConfig.username, dbConfig.password, {
      host: dbConfig.host,
      port: dbConfig.port,
      dialect: dbConfig.dialect,
      logging: dbConfig.logging,
      pool: dbConfig.pool,
      dialectOptions: dbConfig.dialectOptions,
      define: {
        timestamps: true,
        underscored: true,
        freezeTableName: true, // CRITICAL: Prevents table name pluralization
        paranoid: false,
      },
    });

// Test database connection
sequelize.authenticate()
  .then(() => {
    console.log(`[Database] Connection to ${dbConfig.database || 'database'} (${env}) has been established successfully.`);
  })
  .catch(err => {
    console.error(`[Database] Unable to connect to the database (${env}):`, err.message);
  });

// Import models using factory pattern with explicit sequelize instance
const User = require('./User')(sequelize, Sequelize.DataTypes);
const Token = require('./Token')(sequelize, Sequelize.DataTypes);
const Profile = require('./Profile')(sequelize, Sequelize.DataTypes);
const Friend = require('./Friend')(sequelize, Sequelize.DataTypes);
const Chat = require('./Chat')(sequelize, Sequelize.DataTypes);
const Group = require('./Group')(sequelize, Sequelize.DataTypes);
const Message = require('./Message')(sequelize, Sequelize.DataTypes);
const ReadReceipt = require('./ReadReceipt')(sequelize, Sequelize.DataTypes);
const TypingIndicator = require('./TypingIndicator')(sequelize, Sequelize.DataTypes);
const Call = require('./Call')(sequelize, Sequelize.DataTypes);
const Mood = require('./Mood')(sequelize, Sequelize.DataTypes);
const Media = require('./Media')(sequelize, Sequelize.DataTypes);
const Notification = require('./Notification')(sequelize, Sequelize.DataTypes);
const UserStatus = require('./UserStatus')(sequelize, Sequelize.DataTypes);

// Define ChatParticipant junction table (Many-to-Many between User and Chat)
const ChatParticipant = sequelize.define(
  'ChatParticipant',
  {
    id: {
      type: Sequelize.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    chatId: {
      type: Sequelize.INTEGER,
      allowNull: false,
    },
    userId: {
      type: Sequelize.INTEGER,
      allowNull: false,
    },
    role: {
      type: Sequelize.ENUM('owner', 'admin', 'moderator', 'member'),
      defaultValue: 'member',
      allowNull: false,
    },
    joinedAt: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.NOW,
    },
    leftAt: {
      type: Sequelize.DATE,
      allowNull: true,
    },
    notificationsMuted: {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    customSettings: {
      type: Sequelize.JSONB,
      defaultValue: {},
      allowNull: false,
    },
  },
  {
    tableName: 'chat_participants',
    timestamps: true,
    underscored: true,
    freezeTableName: true, // ADD THIS LINE
    indexes: [
      {
        fields: ['chat_id', 'user_id'],
        unique: true,
      },
      {
        fields: ['chat_id'],
      },
      {
        fields: ['user_id'],
      },
    ],
  }
);

// Define SharedMood junction table
const SharedMood = sequelize.define(
  'SharedMood',
  {
    id: {
      type: Sequelize.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    moodId: {
      type: Sequelize.INTEGER,
      allowNull: false,
    },
    userId: {
      type: Sequelize.INTEGER,
      allowNull: false,
    },
    sharedWithId: {
      type: Sequelize.INTEGER,
      allowNull: false,
    },
    sharedAt: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.NOW,
    },
    isViewed: {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    viewedAt: {
      type: Sequelize.DATE,
      allowNull: true,
    },
  },
  {
    tableName: 'shared_moods',
    timestamps: true,
    underscored: true,
    freezeTableName: true, // ADD THIS LINE
    indexes: [
      {
        fields: ['mood_id', 'shared_with_id'],
        unique: true,
      },
      {
        fields: ['user_id'],
      },
      {
        fields: ['shared_with_id'],
      },
    ],
  }
);

// ===== DEFINE ASSOCIATIONS WITH UNIQUE ALIASES =====

// User ↔ Token: One-to-Many
Token.belongsTo(User, { foreignKey: 'userId', as: 'tokenUser' });
User.hasMany(Token, { foreignKey: 'userId', as: 'userTokens' });

// User ↔ Profile: One-to-One
User.hasOne(Profile, { foreignKey: 'userId', as: 'userProfile' });
Profile.belongsTo(User, { foreignKey: 'userId', as: 'profileUser' });

// User ↔ Friend: Many-to-Many through Friend table
User.belongsToMany(User, {
  through: Friend,
  as: 'friends',
  foreignKey: 'requesterId',
  otherKey: 'receiverId',
});
User.belongsToMany(User, {
  through: Friend,
  as: 'friendOf',
  foreignKey: 'receiverId',
  otherKey: 'requesterId',
});
Friend.belongsTo(User, { foreignKey: 'requesterId', as: 'friendRequester' });
Friend.belongsTo(User, { foreignKey: 'receiverId', as: 'friendReceiver' });

// User ↔ Chat: Many-to-Many through ChatParticipant
User.belongsToMany(Chat, {
  through: ChatParticipant,
  as: 'userChats',
  foreignKey: 'userId',
});
Chat.belongsToMany(User, {
  through: ChatParticipant,
  as: 'chatParticipants',
  foreignKey: 'chatId',
});
ChatParticipant.belongsTo(User, { foreignKey: 'userId', as: 'participantUser' });
ChatParticipant.belongsTo(Chat, { foreignKey: 'chatId', as: 'participantChat' });

// Chat ↔ Group: One-to-One
Chat.hasOne(Group, { foreignKey: 'chatId', as: 'chatGroup' });
Group.belongsTo(Chat, { foreignKey: 'chatId', as: 'groupChat' });

// Chat ↔ Message: One-to-Many
Chat.hasMany(Message, { foreignKey: 'chatId', as: 'chatMessages' });
Message.belongsTo(Chat, { foreignKey: 'chatId', as: 'messageChat' });

// User ↔ Message: One-to-Many
User.hasMany(Message, { foreignKey: 'senderId', as: 'userMessages' }); // Changed from 'sentMessages' to avoid conflict
Message.belongsTo(User, { foreignKey: 'senderId', as: 'messageSender' });

// Message ↔ Message: Self-referential for replies
Message.belongsTo(Message, { foreignKey: 'replyToId', as: 'parentMessage' });
Message.hasMany(Message, { foreignKey: 'replyToId', as: 'childMessages' }); // Changed from 'messageReplies'

// Message ↔ ReadReceipt: One-to-Many
Message.hasMany(ReadReceipt, { foreignKey: 'messageId', as: 'messageReadReceipts' });
ReadReceipt.belongsTo(Message, { foreignKey: 'messageId', as: 'readReceiptMessage' });

// User ↔ ReadReceipt: One-to-Many
User.hasMany(ReadReceipt, { foreignKey: 'userId', as: 'userReadReceipts' });
ReadReceipt.belongsTo(User, { foreignKey: 'userId', as: 'readReceiptUser' });

// Chat ↔ TypingIndicator: One-to-Many
Chat.hasMany(TypingIndicator, { foreignKey: 'chatId', as: 'chatTypingIndicators' });
TypingIndicator.belongsTo(Chat, { foreignKey: 'chatId', as: 'typingIndicatorChat' });

// User ↔ TypingIndicator: One-to-Many
User.hasMany(TypingIndicator, { foreignKey: 'userId', as: 'userTypingIndicators' });
TypingIndicator.belongsTo(User, { foreignKey: 'userId', as: 'typingIndicatorUser' });

// Chat ↔ Call: One-to-Many
Chat.hasMany(Call, { foreignKey: 'chatId', as: 'chatCalls' });
Call.belongsTo(Chat, { foreignKey: 'chatId', as: 'callChat' });

// User ↔ Call: One-to-Many
User.hasMany(Call, { foreignKey: 'initiatorId', as: 'initiatedCalls' });
Call.belongsTo(User, { foreignKey: 'initiatorId', as: 'callInitiator' });

// User ↔ Mood: One-to-Many
User.hasMany(Mood, { foreignKey: 'userId', as: 'userMoods' });
Mood.belongsTo(User, { foreignKey: 'userId', as: 'moodUser' });

// Mood ↔ SharedMood: One-to-Many
Mood.hasMany(SharedMood, { foreignKey: 'moodId', as: 'sharedMoods' });
SharedMood.belongsTo(Mood, { foreignKey: 'moodId', as: 'sharedMood' });

// User ↔ SharedMood: One-to-Many (user sharing moods)
User.hasMany(SharedMood, { foreignKey: 'userId', as: 'sharedByUser' }); // Changed alias
SharedMood.belongsTo(User, { foreignKey: 'userId', as: 'sharingUser' }); // Changed alias

// User ↔ SharedMood: One-to-Many (user receiving shared moods)
User.hasMany(SharedMood, { foreignKey: 'sharedWithId', as: 'receivedMoods' });
SharedMood.belongsTo(User, { foreignKey: 'sharedWithId', as: 'sharedWithUser' });

// User ↔ Media: One-to-Many
User.hasMany(Media, { foreignKey: 'userId', as: 'userMedia' });
Media.belongsTo(User, { foreignKey: 'userId', as: 'mediaUser' });

// Message ↔ Media: One-to-One
Message.hasOne(Media, { foreignKey: 'messageId', as: 'messageMedia' });
Media.belongsTo(Message, { foreignKey: 'messageId', as: 'mediaMessage' });

// User ↔ Notification: One-to-Many
User.hasMany(Notification, { foreignKey: 'userId', as: 'userNotifications' });
Notification.belongsTo(User, { foreignKey: 'userId', as: 'notificationUser' });

// User ↔ UserStatus: One-to-One
User.hasOne(UserStatus, { foreignKey: 'userId', as: 'userStatus' });
UserStatus.belongsTo(User, { foreignKey: 'userId', as: 'statusUser' });

// ===== EXPORT ALL MODELS AND SEQUELIZE INSTANCE =====
const allModels = {
  sequelize,
  Sequelize,
  User,
  Token,
  Profile,
  Friend,
  Chat,
  ChatParticipant,
  Group,
  Message,
  ReadReceipt,
  TypingIndicator,
  Call,
  Mood,
  SharedMood,
  Media,
  Notification,
  UserStatus,
};

// Call associate methods if they exist
Object.keys(allModels).forEach(modelName => {
  if (allModels[modelName] && allModels[modelName].associate) {
    try {
      allModels[modelName].associate(allModels);
    } catch (err) {
      console.error(`Error associating model ${modelName}:`, err.message);
    }
  }
});

module.exports = allModels;