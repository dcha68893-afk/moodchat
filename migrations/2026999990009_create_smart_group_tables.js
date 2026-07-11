'use strict';

/**
 * FIX: Smart Group Tools — "relation does not exist" errors.
 *
 * root cause: src/models/GroupTask.js, GroupTaskAssignment.js, GroupEvent.js,
 * GroupAttendance.js, GroupPoll.js, GroupPollOption.js, GroupPollVote.js,
 * GroupNote.js, GroupFile.js, GroupFinance.js, GroupAnalytics.js,
 * GroupActivityLog.js and GroupAISummary.js were all defined as Sequelize
 * models (used throughout smartGroupService.js) but NONE of them ever had a
 * matching migration in this folder — the actual Postgres tables were never
 * created. Every query against them (task boards, events/RSVP, polls, notes,
 * shared files, group finance/levies, analytics, activity log, AI summaries)
 * failed at the DB layer with "relation \"GroupTasks\" does not exist" etc.
 *
 * This migration creates all 13 missing tables to match the model
 * definitions exactly (column names, types, defaults). Idempotent — safe to
 * run even if some of the tables already exist in a given environment.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const has = async (name) => queryInterface.tableExists(name);

    // ── GroupTasks ─────────────────────────────────────────────────────────
    if (!(await has('GroupTasks'))) {
      await queryInterface.createTable('GroupTasks', {
        id:            { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        groupId:       { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Groups', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        createdBy:     { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        title:         { type: Sequelize.STRING(255), allowNull: false },
        description:   { type: Sequelize.TEXT },
        status:        { type: Sequelize.ENUM('pending','active','completed','overdue','cancelled'), defaultValue: 'pending' },
        priority:      { type: Sequelize.ENUM('low','medium','high','urgent'), defaultValue: 'medium' },
        dueDate:       { type: Sequelize.DATE },
        parentTaskId:  { type: Sequelize.INTEGER, allowNull: true },
        attachments:   { type: Sequelize.JSONB, defaultValue: [] },
        isRecurring:   { type: Sequelize.BOOLEAN, defaultValue: false },
        recurringRule: { type: Sequelize.STRING(100) },
        deletedAt:     { type: Sequelize.DATE },
        createdAt:     { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt:     { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addConstraint('GroupTasks', {
        fields: ['parentTaskId'], type: 'foreign key', name: 'fk_grouptasks_parent',
        references: { table: 'GroupTasks', field: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      });
      await queryInterface.addIndex('GroupTasks', ['groupId'], { name: 'idx_grouptasks_group' });
      await queryInterface.addIndex('GroupTasks', ['groupId', 'status'], { name: 'idx_grouptasks_group_status' });
    }

    // ── GroupTaskAssignments ──────────────────────────────────────────────
    if (!(await has('GroupTaskAssignments'))) {
      await queryInterface.createTable('GroupTaskAssignments', {
        id:          { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        taskId:      { type: Sequelize.INTEGER, allowNull: false, references: { model: 'GroupTasks', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        userId:      { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        assignedBy:  { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        completedAt: { type: Sequelize.DATE },
        createdAt:   { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('GroupTaskAssignments', ['taskId'], { name: 'idx_gta_task' });
      await queryInterface.addIndex('GroupTaskAssignments', ['userId'], { name: 'idx_gta_user' });
    }

    // ── GroupEvents ────────────────────────────────────────────────────────
    if (!(await has('GroupEvents'))) {
      await queryInterface.createTable('GroupEvents', {
        id:                 { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        groupId:            { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Groups', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        createdBy:          { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        title:              { type: Sequelize.STRING(255), allowNull: false },
        description:        { type: Sequelize.TEXT },
        location:           { type: Sequelize.STRING(255) },
        latitude:           { type: Sequelize.DECIMAL(10, 7) },
        longitude:          { type: Sequelize.DECIMAL(10, 7) },
        startTime:          { type: Sequelize.DATE, allowNull: false },
        endTime:            { type: Sequelize.DATE },
        timezone:           { type: Sequelize.STRING(50), defaultValue: 'UTC' },
        isRecurring:        { type: Sequelize.BOOLEAN, defaultValue: false },
        recurringRule:      { type: Sequelize.STRING(100) },
        recurrenceRule:     { type: Sequelize.TEXT, allowNull: true, comment: 'JSON: { frequency, interval, count, endDate }' },
        recurrenceIndex:    { type: Sequelize.INTEGER, allowNull: true, defaultValue: 0 },
        recurrenceParentId: { type: Sequelize.INTEGER, allowNull: true, comment: 'ID of first event in series' },
        rsvpEnabled:        { type: Sequelize.BOOLEAN, defaultValue: true },
        maxAttendees:       { type: Sequelize.INTEGER },
        coverImage:         { type: Sequelize.STRING(500) },
        livestreamUrl:      { type: Sequelize.STRING(500) },
        qrCode:             { type: Sequelize.STRING(500) },
        status:             { type: Sequelize.ENUM('draft','upcoming','live','completed','cancelled'), defaultValue: 'upcoming' },
        deletedAt:          { type: Sequelize.DATE },
        createdAt:          { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt:          { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('GroupEvents', ['groupId'], { name: 'idx_groupevents_group' });
      await queryInterface.addIndex('GroupEvents', ['groupId', 'startTime'], { name: 'idx_groupevents_group_start' });
    }

    // ── GroupAttendance ────────────────────────────────────────────────────
    if (!(await has('GroupAttendance'))) {
      await queryInterface.createTable('GroupAttendance', {
        id:         { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        eventId:    { type: Sequelize.INTEGER, allowNull: false, references: { model: 'GroupEvents', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        groupId:    { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Groups', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        userId:     { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        status:     { type: Sequelize.ENUM('pending','present','absent','late','excused','rsvp_yes','rsvp_no','rsvp_maybe'), defaultValue: 'pending' },
        rsvpAt:     { type: Sequelize.DATE },
        markedAt:   { type: Sequelize.DATE },
        markedBy:   { type: Sequelize.INTEGER },
        gpsLat:     { type: Sequelize.DECIMAL(10, 7) },
        gpsLon:     { type: Sequelize.DECIMAL(10, 7) },
        qrVerified: { type: Sequelize.BOOLEAN, defaultValue: false },
        note:       { type: Sequelize.TEXT },
        createdAt:  { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt:  { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('GroupAttendance', ['eventId'], { name: 'idx_gattendance_event' });
      await queryInterface.addIndex('GroupAttendance', ['eventId', 'userId'], { name: 'idx_gattendance_event_user', unique: true });
    }

    // ── GroupPolls ─────────────────────────────────────────────────────────
    if (!(await has('GroupPolls'))) {
      await queryInterface.createTable('GroupPolls', {
        id:          { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        groupId:     { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Groups', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        createdBy:   { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        question:    { type: Sequelize.STRING(500), allowNull: false },
        type:        { type: Sequelize.ENUM('single','multiple','quiz','rating'), defaultValue: 'single' },
        isAnonymous: { type: Sequelize.BOOLEAN, defaultValue: false },
        allowChange: { type: Sequelize.BOOLEAN, defaultValue: true },
        showResults: { type: Sequelize.ENUM('always','after_vote','after_close','admin_only'), defaultValue: 'always' },
        endsAt:      { type: Sequelize.DATE },
        status:      { type: Sequelize.ENUM('draft','active','closed'), defaultValue: 'active' },
        deletedAt:   { type: Sequelize.DATE },
        createdAt:   { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt:   { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('GroupPolls', ['groupId'], { name: 'idx_grouppolls_group' });
    }

    // ── GroupPollOptions ───────────────────────────────────────────────────
    if (!(await has('GroupPollOptions'))) {
      await queryInterface.createTable('GroupPollOptions', {
        id:        { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        pollId:    { type: Sequelize.INTEGER, allowNull: false, references: { model: 'GroupPolls', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        text:      { type: Sequelize.STRING(255), allowNull: false },
        emoji:     { type: Sequelize.STRING(10) },
        isCorrect: { type: Sequelize.BOOLEAN, defaultValue: false },
        position:  { type: Sequelize.INTEGER, defaultValue: 0 },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('GroupPollOptions', ['pollId'], { name: 'idx_gpolloptions_poll' });
    }

    // ── GroupPollVotes ─────────────────────────────────────────────────────
    if (!(await has('GroupPollVotes'))) {
      await queryInterface.createTable('GroupPollVotes', {
        id:        { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        pollId:    { type: Sequelize.INTEGER, allowNull: false, references: { model: 'GroupPolls', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        optionId:  { type: Sequelize.INTEGER, allowNull: false, references: { model: 'GroupPollOptions', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        userId:    { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('GroupPollVotes', ['pollId', 'userId'], { name: 'idx_gpollvotes_poll_user' });
      await queryInterface.addIndex('GroupPollVotes', ['optionId'], { name: 'idx_gpollvotes_option' });
    }

    // ── GroupNotes ─────────────────────────────────────────────────────────
    if (!(await has('GroupNotes'))) {
      await queryInterface.createTable('GroupNotes', {
        id:          { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        groupId:     { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Groups', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        createdBy:   { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        title:       { type: Sequelize.STRING(255), allowNull: false },
        content:     { type: Sequelize.TEXT },
        contentType: { type: Sequelize.ENUM('markdown','richtext','plain'), defaultValue: 'markdown' },
        isPinned:    { type: Sequelize.BOOLEAN, defaultValue: false },
        tags:        { type: Sequelize.JSONB, defaultValue: [] },
        category:    { type: Sequelize.STRING(100) },
        version:     { type: Sequelize.INTEGER, defaultValue: 1 },
        deletedAt:   { type: Sequelize.DATE },
        createdAt:   { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt:   { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('GroupNotes', ['groupId'], { name: 'idx_groupnotes_group' });
    }

    // ── GroupFiles ─────────────────────────────────────────────────────────
    if (!(await has('GroupFiles'))) {
      await queryInterface.createTable('GroupFiles', {
        id:            { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        groupId:       { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Groups', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        uploadedBy:    { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        name:          { type: Sequelize.STRING(255), allowNull: false },
        url:           { type: Sequelize.STRING(1000), allowNull: false },
        mimeType:      { type: Sequelize.STRING(100) },
        sizeBytes:     { type: Sequelize.BIGINT, defaultValue: 0 },
        folder:        { type: Sequelize.STRING(255), defaultValue: '/' },
        tags:          { type: Sequelize.JSONB, defaultValue: [] },
        thumbnailUrl:  { type: Sequelize.STRING(1000) },
        downloadCount: { type: Sequelize.INTEGER, defaultValue: 0 },
        isPublic:      { type: Sequelize.BOOLEAN, defaultValue: true },
        deletedAt:     { type: Sequelize.DATE },
        createdAt:     { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt:     { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('GroupFiles', ['groupId'], { name: 'idx_groupfiles_group' });
    }

    // ── GroupFinances ──────────────────────────────────────────────────────
    if (!(await has('GroupFinances'))) {
      await queryInterface.createTable('GroupFinances', {
        id:             { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        groupId:        { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Groups', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        createdBy:      { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        type:           { type: Sequelize.ENUM('income','expense','transfer','levy'), allowNull: false },
        amount:         { type: Sequelize.DECIMAL(15, 2), allowNull: false },
        currency:       { type: Sequelize.STRING(10), defaultValue: 'KES' },
        description:    { type: Sequelize.TEXT },
        category:       { type: Sequelize.STRING(100) },
        reference:      { type: Sequelize.STRING(255) },
        paidBy:         { type: Sequelize.INTEGER },
        approvedBy:     { type: Sequelize.INTEGER },
        status:         { type: Sequelize.ENUM('pending','approved','rejected','completed'), defaultValue: 'pending' },
        receipt:        { type: Sequelize.STRING(1000) },
        runningBalance: { type: Sequelize.DECIMAL(15, 2), allowNull: false, defaultValue: 0, comment: 'Group balance after this transaction — computed on insert' },
        deletedAt:      { type: Sequelize.DATE },
        createdAt:      { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt:      { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('GroupFinances', ['groupId'], { name: 'idx_groupfinances_group' });
    }

    // ── group_analytics ────────────────────────────────────────────────────
    if (!(await has('group_analytics'))) {
      await queryInterface.createTable('group_analytics', {
        id:             { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        group_id:       { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Groups', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        date:           { type: Sequelize.DATEONLY, allowNull: false, defaultValue: Sequelize.NOW },
        message_count:  { type: Sequelize.INTEGER, defaultValue: 0 },
        active_members: { type: Sequelize.INTEGER, defaultValue: 0 },
        new_members:    { type: Sequelize.INTEGER, defaultValue: 0 },
        total_reactions:{ type: Sequelize.INTEGER, defaultValue: 0 },
        media_shared:   { type: Sequelize.INTEGER, defaultValue: 0 },
        call_minutes:   { type: Sequelize.INTEGER, defaultValue: 0 },
        createdAt:      { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt:      { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('group_analytics', ['group_id', 'date'], { name: 'idx_ganalytics_group_date', unique: true });
      await queryInterface.addIndex('group_analytics', ['date'], { name: 'idx_ganalytics_date' });
    }

    // ── GroupActivityLogs ──────────────────────────────────────────────────
    if (!(await has('GroupActivityLogs'))) {
      await queryInterface.createTable('GroupActivityLogs', {
        id:         { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        groupId:    { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Groups', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        userId:     { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        action:     { type: Sequelize.STRING(100), allowNull: false },
        module:     { type: Sequelize.STRING(50) },
        targetId:   { type: Sequelize.INTEGER },
        targetType: { type: Sequelize.STRING(50) },
        meta:       { type: Sequelize.JSONB, defaultValue: {} },
        createdAt:  { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('GroupActivityLogs', ['groupId'], { name: 'idx_gactivitylog_group' });
      await queryInterface.addIndex('GroupActivityLogs', ['groupId', 'createdAt'], { name: 'idx_gactivitylog_group_created' });
    }

    // ── GroupAISummaries ───────────────────────────────────────────────────
    if (!(await has('GroupAISummaries'))) {
      await queryInterface.createTable('GroupAISummaries', {
        id:           { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        groupId:      { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Groups', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        type:         { type: Sequelize.ENUM('daily','meeting','unread','action_items','weekly'), allowNull: false },
        summary:      { type: Sequelize.TEXT, allowNull: false },
        actionItems:  { type: Sequelize.JSONB, defaultValue: [] },
        keywords:     { type: Sequelize.JSONB, defaultValue: [] },
        messageRange: { type: Sequelize.JSONB },
        generatedBy:  { type: Sequelize.STRING(50), defaultValue: 'openai' },
        createdAt:    { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('GroupAISummaries', ['groupId'], { name: 'idx_gaisummaries_group' });
    }
  },

  async down(queryInterface) {
    // Drop in reverse FK-dependency order
    await queryInterface.dropTable('GroupAISummaries').catch(() => {});
    await queryInterface.dropTable('GroupActivityLogs').catch(() => {});
    await queryInterface.dropTable('group_analytics').catch(() => {});
    await queryInterface.dropTable('GroupFinances').catch(() => {});
    await queryInterface.dropTable('GroupFiles').catch(() => {});
    await queryInterface.dropTable('GroupNotes').catch(() => {});
    await queryInterface.dropTable('GroupPollVotes').catch(() => {});
    await queryInterface.dropTable('GroupPollOptions').catch(() => {});
    await queryInterface.dropTable('GroupPolls').catch(() => {});
    await queryInterface.dropTable('GroupAttendance').catch(() => {});
    await queryInterface.dropTable('GroupEvents').catch(() => {});
    await queryInterface.dropTable('GroupTaskAssignments').catch(() => {});
    await queryInterface.dropTable('GroupTasks').catch(() => {});
  },
};
