// models/index.js (FIXED ASSOCIATIONS - UPDATED FOR RENDER)
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
    database: process.env.DB_NAME || 'denismoo',
    username: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'a8UIFwP8552hGbYI9x7O3Dp7gs3vb6TV',
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
        underscored: false, // Changed to false to match migrations
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
        underscored: false, // Changed to false to match migrations
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

// IMPORTANT: Define models that match your migration files
// These models must have the exact same table names as migrations

// Define Users model to match migration
const Users = sequelize.define('Users', {
  id: {
    type: Sequelize.INTEGER,
    primaryKey: true,
    autoIncrement: true,
    allowNull: false
  },
  username: {
    type: Sequelize.STRING,
    allowNull: false,
    unique: true
  },
  email: {
    type: Sequelize.STRING,
    allowNull: false,
    unique: true
  },
  password: {
    type: Sequelize.STRING,
    allowNull: false
  },
  firstName: {
    type: Sequelize.STRING,
    allowNull: true
  },
  lastName: {
    type: Sequelize.STRING,
    allowNull: true
  },
  avatar: {
    type: Sequelize.STRING,
    allowNull: true
  },
  status: {
    type: Sequelize.STRING,
    defaultValue: 'offline',
    allowNull: false
  },
  isActive: {
    type: Sequelize.BOOLEAN,
    defaultValue: true,
    allowNull: false
  },
  isVerified: {
    type: Sequelize.BOOLEAN,
    defaultValue: false,
    allowNull: false
  },
  lastSeen: {
    type: Sequelize.DATE,
    allowNull: true
  },
  createdAt: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW
  },
  updatedAt: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW
  }
}, {
  tableName: 'Users',
  timestamps: true,
  freezeTableName: true
});

// Define Messages model to match migration
const Messages = sequelize.define('Messages', {
  id: {
    type: Sequelize.INTEGER,
    primaryKey: true,
    autoIncrement: true,
    allowNull: false
  },
  senderId: {
    type: Sequelize.INTEGER,
    allowNull: false,
    references: {
      model: 'Users',
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE'
  },
  receiverId: {
    type: Sequelize.INTEGER,
    allowNull: true,
    references: {
      model: 'Users',
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE'
  },
  groupId: {
    type: Sequelize.INTEGER,
    allowNull: true,
    references: {
      model: 'Groups',
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE'
  },
  content: {
    type: Sequelize.TEXT,
    allowNull: false
  },
  type: {
    type: Sequelize.STRING,
    allowNull: false
  },
  createdAt: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW
  },
  updatedAt: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW
  }
}, {
  tableName: 'Messages',
  timestamps: true,
  freezeTableName: true
});

// Define Groups model to match migration
const Groups = sequelize.define('Groups', {
  id: {
    type: Sequelize.INTEGER,
    primaryKey: true,
    autoIncrement: true,
    allowNull: false
  },
  name: {
    type: Sequelize.STRING,
    allowNull: false
  },
  createdBy: {
    type: Sequelize.INTEGER,
    allowNull: true,
    references: {
      model: 'Users',
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  },
  createdAt: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW
  },
  updatedAt: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW
  }
}, {
  tableName: 'Groups',
  timestamps: true,
  freezeTableName: true
});

// Define Friends model to match migration
const Friends = sequelize.define('Friends', {
  id: {
    type: Sequelize.INTEGER,
    primaryKey: true,
    autoIncrement: true,
    allowNull: false
  },
  userId: {
    type: Sequelize.INTEGER,
    allowNull: false,
    references: {
      model: 'Users',
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE'
  },
  friendId: {
    type: Sequelize.INTEGER,
    allowNull: false,
    references: {
      model: 'Users',
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE'
  },
  status: {
    type: Sequelize.STRING,
    allowNull: false
  },
  createdAt: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW
  },
  updatedAt: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW
  }
}, {
  tableName: 'Friends',
  timestamps: true,
  freezeTableName: true
});

// Define Status model to match migration
const Status = sequelize.define('Status', {
  id: {
    type: Sequelize.INTEGER,
    primaryKey: true,
    autoIncrement: true,
    allowNull: false
  },
  userId: {
    type: Sequelize.INTEGER,
    allowNull: false,
    references: {
      model: 'Users',
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE'
  },
  content: {
    type: Sequelize.TEXT,
    allowNull: true
  },
  type: {
    type: Sequelize.STRING,
    allowNull: true
  },
  createdAt: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW
  },
  updatedAt: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW
  }
}, {
  tableName: 'Status',
  timestamps: true,
  freezeTableName: true
});

// Define GroupMembers model to match migration
const GroupMembers = sequelize.define('GroupMembers', {
  id: {
    type: Sequelize.INTEGER,
    primaryKey: true,
    autoIncrement: true,
    allowNull: false
  },
  groupId: {
    type: Sequelize.INTEGER,
    allowNull: false,
    references: {
      model: 'Groups',
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE'
  },
  userId: {
    type: Sequelize.INTEGER,
    allowNull: false,
    references: {
      model: 'Users',
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE'
  },
  role: {
    type: Sequelize.STRING,
    allowNull: true
  },
  joinedAt: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW
  },
  createdAt: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW
  },
  updatedAt: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW
  }
}, {
  tableName: 'GroupMembers',
  timestamps: true,
  freezeTableName: true
});

// Define Calls model to match migration
const Calls = sequelize.define('Calls', {
  id: {
    type: Sequelize.INTEGER,
    primaryKey: true,
    autoIncrement: true,
    allowNull: false
  },
  callerId: {
    type: Sequelize.INTEGER,
    allowNull: true,
    references: {
      model: 'Users',
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  },
  receiverId: {
    type: Sequelize.INTEGER,
    allowNull: true,
    references: {
      model: 'Users',
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  },
  groupId: {
    type: Sequelize.INTEGER,
    allowNull: true,
    references: {
      model: 'Groups',
      key: 'id'
    },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL'
  },
  callType: {
    type: Sequelize.STRING,
    allowNull: true
  },
  status: {
    type: Sequelize.STRING,
    allowNull: true
  },
  startedAt: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW
  },
  endedAt: {
    type: Sequelize.DATE,
    allowNull: true
  },
  createdAt: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW
  },
  updatedAt: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.NOW
  }
}, {
  tableName: 'Calls',
  timestamps: true,
  freezeTableName: true
});

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
    tableName: 'ChatParticipants',
    timestamps: true,
    freezeTableName: true,
    indexes: [
      {
        fields: ['chatId', 'userId'],
        unique: true,
      },
      {
        fields: ['chatId'],
      },
      {
        fields: ['userId'],
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
    tableName: 'SharedMoods',
    timestamps: true,
    freezeTableName: true,
    indexes: [
      {
        fields: ['moodId', 'sharedWithId'],
        unique: true,
      },
      {
        fields: ['userId'],
      },
      {
        fields: ['sharedWithId'],
      },
    ],
  }
);

// ===== DEFINE ASSOCIATIONS WITH UNIQUE ALIASES =====

// User ↔ Token: One-to-Many
Token.belongsTo(Users, { foreignKey: 'userId', as: 'tokenUser' });
Users.hasMany(Token, { foreignKey: 'userId', as: 'userTokens' });

// User ↔ Profile: One-to-One
Users.hasOne(Profile, { foreignKey: 'userId', as: 'userProfile' });
Profile.belongsTo(Users, { foreignKey: 'userId', as: 'profileUser' });

// User ↔ Friend: Many-to-Many through Friend table
Users.belongsToMany(Users, {
  through: Friends,
  as: 'friends',
  foreignKey: 'requesterId',
  otherKey: 'receiverId',
});
Users.belongsToMany(Users, {
  through: Friends,
  as: 'friendOf',
  foreignKey: 'receiverId',
  otherKey: 'requesterId',
});
Friends.belongsTo(Users, { foreignKey: 'requesterId', as: 'friendRequester' });
Friends.belongsTo(Users, { foreignKey: 'receiverId', as: 'friendReceiver' });

// User ↔ Chat: Many-to-Many through ChatParticipant
Users.belongsToMany(Chat, {
  through: ChatParticipant,
  as: 'userChats',
  foreignKey: 'userId',
});
Chat.belongsToMany(Users, {
  through: ChatParticipant,
  as: 'chatParticipants',
  foreignKey: 'chatId',
});
ChatParticipant.belongsTo(Users, { foreignKey: 'userId', as: 'participantUser' });
ChatParticipant.belongsTo(Chat, { foreignKey: 'chatId', as: 'participantChat' });

// Chat ↔ Group: One-to-One
Chat.hasOne(Groups, { foreignKey: 'chatId', as: 'chatGroup' });
Groups.belongsTo(Chat, { foreignKey: 'chatId', as: 'groupChat' });

// Chat ↔ Message: One-to-Many
Chat.hasMany(Messages, { foreignKey: 'chatId', as: 'chatMessages' });
Messages.belongsTo(Chat, { foreignKey: 'chatId', as: 'messageChat' });

// User ↔ Message: One-to-Many
Users.hasMany(Messages, { foreignKey: 'senderId', as: 'userMessages' }); // Changed from 'sentMessages' to avoid conflict
Messages.belongsTo(Users, { foreignKey: 'senderId', as: 'messageSender' });

// Message ↔ Message: Self-referential for replies
Messages.belongsTo(Messages, { foreignKey: 'replyToId', as: 'parentMessage' });
Messages.hasMany(Messages, { foreignKey: 'replyToId', as: 'childMessages' }); // Changed from 'messageReplies'

// Message ↔ ReadReceipt: One-to-Many
Messages.hasMany(ReadReceipt, { foreignKey: 'messageId', as: 'messageReadReceipts' });
ReadReceipt.belongsTo(Messages, { foreignKey: 'messageId', as: 'readReceiptMessage' });

// User ↔ ReadReceipt: One-to-Many
Users.hasMany(ReadReceipt, { foreignKey: 'userId', as: 'userReadReceipts' });
ReadReceipt.belongsTo(Users, { foreignKey: 'userId', as: 'readReceiptUser' });

// Chat ↔ TypingIndicator: One-to-Many
Chat.hasMany(TypingIndicator, { foreignKey: 'chatId', as: 'chatTypingIndicators' });
TypingIndicator.belongsTo(Chat, { foreignKey: 'chatId', as: 'typingIndicatorChat' });

// User ↔ TypingIndicator: One-to-Many
Users.hasMany(TypingIndicator, { foreignKey: 'userId', as: 'userTypingIndicators' });
TypingIndicator.belongsTo(Users, { foreignKey: 'userId', as: 'typingIndicatorUser' });

// Chat ↔ Call: One-to-Many
Chat.hasMany(Calls, { foreignKey: 'chatId', as: 'chatCalls' });
Calls.belongsTo(Chat, { foreignKey: 'chatId', as: 'callChat' });

// User ↔ Call: One-to-Many
Users.hasMany(Calls, { foreignKey: 'initiatorId', as: 'initiatedCalls' });
Calls.belongsTo(Users, { foreignKey: 'initiatorId', as: 'callInitiator' });

// User ↔ Mood: One-to-Many
Users.hasMany(Mood, { foreignKey: 'userId', as: 'userMoods' });
Mood.belongsTo(Users, { foreignKey: 'userId', as: 'moodUser' });

// Mood ↔ SharedMood: One-to-Many
Mood.hasMany(SharedMood, { foreignKey: 'moodId', as: 'sharedMoods' });
SharedMood.belongsTo(Mood, { foreignKey: 'moodId', as: 'sharedMood' });

// User ↔ SharedMood: One-to-Many (user sharing moods)
Users.hasMany(SharedMood, { foreignKey: 'userId', as: 'sharedByUser' }); // Changed alias
SharedMood.belongsTo(Users, { foreignKey: 'userId', as: 'sharingUser' }); // Changed alias

// User ↔ SharedMood: One-to-Many (user receiving shared moods)
Users.hasMany(SharedMood, { foreignKey: 'sharedWithId', as: 'receivedMoods' });
SharedMood.belongsTo(Users, { foreignKey: 'sharedWithId', as: 'sharedWithUser' });

// User ↔ Media: One-to-Many
Users.hasMany(Media, { foreignKey: 'userId', as: 'userMedia' });
Media.belongsTo(Users, { foreignKey: 'userId', as: 'mediaUser' });

// Message ↔ Media: One-to-One
Messages.hasOne(Media, { foreignKey: 'messageId', as: 'messageMedia' });
Media.belongsTo(Messages, { foreignKey: 'messageId', as: 'mediaMessage' });

// User ↔ Notification: One-to-Many
Users.hasMany(Notification, { foreignKey: 'userId', as: 'userNotifications' });
Notification.belongsTo(Users, { foreignKey: 'userId', as: 'notificationUser' });

// User ↔ UserStatus: One-to-One
Users.hasOne(UserStatus, { foreignKey: 'userId', as: 'userStatus' });
UserStatus.belongsTo(Users, { foreignKey: 'userId', as: 'statusUser' });

// ===== EXPORT ALL MODELS AND SEQUELIZE INSTANCE =====
const allModels = {
  sequelize,
  Sequelize,
  // Migration-based models
  Users,
  Messages,
  Groups,
  Friends,
  Status,
  GroupMembers,
  Calls,
  // Original models
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