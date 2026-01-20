// models/index.js (FIXED ASSOCIATIONS)
const { Sequelize } = require('sequelize');
const config = require('../config');

// Database configuration - using config from the corrected config/index.js
const env = config.nodeEnv || 'development';

// Get database configuration based on environment
const getDbConfig = () => {
  // If DATABASE_URL is provided (Render, Heroku), use it
  if (config.database.url) {
    console.log(`[Database] Using DATABASE_URL for ${env} environment`);
    return {
      url: config.database.url,
      dialect: 'postgres',
      logging: config.database.logging,
      pool: config.database.pool,
      dialectOptions: config.database.ssl ? {
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
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    username: config.database.user,
    password: config.database.password,
    dialect: config.database.dialect,
    logging: config.database.logging,
    pool: config.database.pool,
    dialectOptions: config.database.ssl ? {
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

// ===== DEFINE ASSOCIATIONS =====

// User ↔ Token: One-to-Many (A user can have multiple tokens)
Token.belongsTo(User, { foreignKey: 'userId', as: 'tokenUser' }); // CHANGED alias from 'user' to 'tokenUser'
User.hasMany(Token, { foreignKey: 'userId', as: 'userTokens' });

// User ↔ Profile: One-to-One (A user has one profile)
User.hasOne(Profile, { foreignKey: 'userId', as: 'userProfile' }); // CHANGED alias from 'profile' to 'userProfile'
Profile.belongsTo(User, { foreignKey: 'userId', as: 'profileUser' }); // CHANGED alias from 'user' to 'profileUser'

// User ↔ Friend: Many-to-Many through Friend table (Friendship relationships)
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
Friend.belongsTo(User, { foreignKey: 'requesterId', as: 'friendRequester' }); // CHANGED alias from 'requester' to 'friendRequester'
Friend.belongsTo(User, { foreignKey: 'receiverId', as: 'friendReceiver' }); // CHANGED alias from 'receiver' to 'friendReceiver'

// User ↔ Chat: Many-to-Many through ChatParticipant (Chat membership)
User.belongsToMany(Chat, {
  through: ChatParticipant,
  as: 'userChats', // CHANGED alias from 'chats' to 'userChats'
  foreignKey: 'userId',
});
Chat.belongsToMany(User, {
  through: ChatParticipant,
  as: 'chatParticipants',
  foreignKey: 'chatId',
});
ChatParticipant.belongsTo(User, { foreignKey: 'userId', as: 'participantUser' });
ChatParticipant.belongsTo(Chat, { foreignKey: 'chatId', as: 'participantChat' });

// Chat ↔ Group: One-to-One (A chat can have group info)
Chat.hasOne(Group, { foreignKey: 'chatId', as: 'chatGroup' }); // CHANGED alias from 'group' to 'chatGroup'
Group.belongsTo(Chat, { foreignKey: 'chatId', as: 'groupChat' }); // CHANGED alias from 'chat' to 'groupChat'

// Chat ↔ Message: One-to-Many (A chat can have many messages)
Chat.hasMany(Message, { foreignKey: 'chatId', as: 'chatMessages' }); // CHANGED alias from 'messages' to 'chatMessages'
Message.belongsTo(Chat, { foreignKey: 'chatId', as: 'messageChat' }); // CHANGED alias from 'chat' to 'messageChat'

// User ↔ Message: One-to-Many (A user can send many messages)
User.hasMany(Message, { foreignKey: 'senderId', as: 'sentMessages' });
Message.belongsTo(User, { foreignKey: 'senderId', as: 'messageSender' }); // CHANGED alias from 'sender' to 'messageSender'

// Message ↔ Message: Self-referential for replies (A message can reply to another)
Message.belongsTo(Message, { foreignKey: 'replyToId', as: 'parentMessage' }); // CHANGED alias from 'replyTo' to 'parentMessage'
Message.hasMany(Message, { foreignKey: 'replyToId', as: 'messageReplies' }); // CHANGED alias from 'replies' to 'messageReplies'

// Message ↔ ReadReceipt: One-to-Many (A message can have many read receipts)
Message.hasMany(ReadReceipt, { foreignKey: 'messageId', as: 'messageReadReceipts' }); // CHANGED alias from 'readReceipts' to 'messageReadReceipts'
ReadReceipt.belongsTo(Message, { foreignKey: 'messageId', as: 'readReceiptMessage' }); // CHANGED alias from 'message' to 'readReceiptMessage'

// User ↔ ReadReceipt: One-to-Many (A user can have many read receipts)
User.hasMany(ReadReceipt, { foreignKey: 'userId', as: 'userReadReceipts' }); // CHANGED alias from 'readReceipts' to 'userReadReceipts'
ReadReceipt.belongsTo(User, { foreignKey: 'userId', as: 'readReceiptUser' }); // CHANGED alias from 'user' to 'readReceiptUser'

// Chat ↔ TypingIndicator: One-to-Many (A chat can have many typing indicators)
Chat.hasMany(TypingIndicator, { foreignKey: 'chatId', as: 'chatTypingIndicators' }); // CHANGED alias from 'typingIndicators' to 'chatTypingIndicators'
TypingIndicator.belongsTo(Chat, { foreignKey: 'chatId', as: 'typingIndicatorChat' }); // CHANGED alias from 'chat' to 'typingIndicatorChat'

// User ↔ TypingIndicator: One-to-Many (A user can have many typing indicators)
User.hasMany(TypingIndicator, { foreignKey: 'userId', as: 'userTypingIndicators' }); // CHANGED alias from 'typingIndicators' to 'userTypingIndicators'
TypingIndicator.belongsTo(User, { foreignKey: 'userId', as: 'typingIndicatorUser' }); // CHANGED alias from 'user' to 'typingIndicatorUser'

// Chat ↔ Call: One-to-Many (A chat can have many calls)
Chat.hasMany(Call, { foreignKey: 'chatId', as: 'chatCalls' }); // CHANGED alias from 'calls' to 'chatCalls'
Call.belongsTo(Chat, { foreignKey: 'chatId', as: 'callChat' }); // CHANGED alias from 'chat' to 'callChat'

// User ↔ Call: One-to-Many (A user can initiate many calls)
User.hasMany(Call, { foreignKey: 'initiatorId', as: 'initiatedCalls' });
Call.belongsTo(User, { foreignKey: 'initiatorId', as: 'callInitiator' }); // CHANGED alias from 'initiator' to 'callInitiator'

// User ↔ Mood: One-to-Many (A user can have many moods)
User.hasMany(Mood, { foreignKey: 'userId', as: 'userMoods' }); // CHANGED alias from 'moods' to 'userMoods'
Mood.belongsTo(User, { foreignKey: 'userId', as: 'moodUser' }); // CHANGED alias from 'user' to 'moodUser'

// Mood ↔ SharedMood: One-to-Many (A mood can be shared with many users)
Mood.hasMany(SharedMood, { foreignKey: 'moodId', as: 'sharedMoods' });
SharedMood.belongsTo(Mood, { foreignKey: 'moodId', as: 'sharedMood' }); // CHANGED alias from 'mood' to 'sharedMood'

// User ↔ SharedMood: One-to-Many (A user can share many moods)
User.hasMany(SharedMood, { foreignKey: 'userId', as: 'sharedMoods' });
SharedMood.belongsTo(User, { foreignKey: 'userId', as: 'sharedMoodUser' }); // CHANGED alias from 'user' to 'sharedMoodUser'

// User ↔ SharedMood: One-to-Many (A user can receive many shared moods)
User.hasMany(SharedMood, { foreignKey: 'sharedWithId', as: 'receivedMoods' });
SharedMood.belongsTo(User, { foreignKey: 'sharedWithId', as: 'sharedWithUser' });

// User ↔ Media: One-to-Many (A user can upload many media files)
User.hasMany(Media, { foreignKey: 'userId', as: 'userMedia' }); // CHANGED alias from 'media' to 'userMedia'
Media.belongsTo(User, { foreignKey: 'userId', as: 'mediaUser' }); // CHANGED alias from 'user' to 'mediaUser'

// Message ↔ Media: One-to-One (A message can have one media attachment)
Message.hasOne(Media, { foreignKey: 'messageId', as: 'messageMedia' }); // CHANGED alias from 'media' to 'messageMedia'
Media.belongsTo(Message, { foreignKey: 'messageId', as: 'mediaMessage' }); // CHANGED alias from 'message' to 'mediaMessage'

// User ↔ Notification: One-to-Many (A user can have many notifications)
User.hasMany(Notification, { foreignKey: 'userId', as: 'userNotifications' }); // CHANGED alias from 'notifications' to 'userNotifications'
Notification.belongsTo(User, { foreignKey: 'userId', as: 'notificationUser' }); // CHANGED alias from 'user' to 'notificationUser'

// ===== EXPORT ALL MODELS AND SEQUELIZE INSTANCE =====
module.exports = {
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
};