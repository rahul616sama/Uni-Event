import * as admin from 'firebase-admin';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Connect to Firebase
admin.initializeApp();
const db = admin.firestore();

// This is where we keep track of which migrations have already run
const TRACKER_DOC = 'migrations/applied';

// Get the list of migrations that have already been applied
async function getAppliedMigrations() {
    const doc = await db.doc(TRACKER_DOC).get();
    if (!doc.exists) return [];
    return doc.data()?.applied ?? [];
}

// Save a migration name to the tracker so it won't run again
async function markAsDone(migrationName: string, alreadyApplied: string[]) {
    await db.doc(TRACKER_DOC).set({
        applied: [...alreadyApplied, migrationName],
    });
}

// Remove a migration from the tracker (used when rolling back)
async function markAsUndone(migrationName: string, alreadyApplied: string[]) {
    await db.doc(TRACKER_DOC).set({
        applied: alreadyApplied.filter(m => m !== migrationName),
    });
}

// Run all pending migrations (up)
async function runMigrations() {
    const applied = await getAppliedMigrations();

    const files = fs
        .readdirSync(__dirname)
        .filter(f => f.endsWith('.ts') && f !== 'migrate.ts')
        .sort();

    if (files.length === 0) {
        console.log('No migrations found.');
        return;
    }

    for (const file of files) {
        if (applied.includes(file)) {
            console.log(`Already applied: ${file} — skipping.`);
            continue;
        }

        console.log(`Running: ${file}`);

        const migration = await import(path.join(__dirname, file));
        await migration.up(db);

        // Add to local list first, then save to Firestore
        applied.push(file);
        await markAsDone(file, applied);

        console.log(`Finished: ${file} ✓`);
    }

    console.log('All migrations done!');
}

// Rollback the last applied migration (down)
async function rollbackMigration() {
    const applied = await getAppliedMigrations();

    if (applied.length === 0) {
        console.log('No migrations to roll back.');
        return;
    }

    // Get the last applied migration
    const lastFile = applied[applied.length - 1];

    console.log(`Rolling back: ${lastFile}`);

    const migration = await import(path.join(__dirname, lastFile));

    if (!migration.down) {
        console.error(`No down() function found in ${lastFile}`);
        process.exit(1);
    }

    await migration.down(db);
    await markAsUndone(lastFile, applied);

    console.log(`Rolled back: ${lastFile} ✓`);
}

// Check command line argument to decide what to do
const command = process.argv[2];

if (command === 'down') {
    rollbackMigration().catch(err => {
        console.error('Rollback error:', err);
        process.exit(1);
    });
} else {
    runMigrations().catch(err => {
        console.error('Migration error:', err);
        process.exit(1);
    });
}