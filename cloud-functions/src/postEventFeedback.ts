import * as admin from "firebase-admin";
import * as functions from "firebase-functions";

const SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
const TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_FEEDBACK;

// Returns true if email was sent successfully, false if it failed
async function sendEmail(name: string, email: string, eventTitle: string, eventId: string): Promise<boolean> {
    const feedbackLink = `https://unievent-ez2w.onrender.com/event/${eventId}/feedback`;

    try {
        const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                service_id: SERVICE_ID,
                template_id: TEMPLATE_ID,
                user_id: PUBLIC_KEY,
                template_params: {
                    to_name: name || "Participant",
                    to_email: email,
                    subject: `Feedback Request: ${eventTitle}`,
                    message: `Thank you for attending ${eventTitle}. Please share your feedback!`,
                    event_title: eventTitle,
                    feedback_link: feedbackLink,
                },
            }),
        });

        if (response.ok) return true;

        console.error(`Email failed for ${email}: ${await response.text()}`);
        return false;

    } catch (e) {
        console.error(`Email error for ${email}:`, e);
        return false;
    }
}

export const sendPostEventFeedback = functions.pubsub
    .schedule("every 60 minutes")
    .onRun(async () => {
        const db = admin.firestore();
        const now = new Date();

        const events = await db
            .collection("events")
            .where("feedbackRequestSent", "in", [false, null])
            .get();

        if (events.empty) {
            console.log("No events to process.");
            return null;
        }

        for (const eventDoc of events.docs) {
            const event = eventDoc.data();
            const rawEnd = event.endAt?.toDate ? event.endAt.toDate() : new Date(event.endAt);

            // Skip if endAt is missing or invalid
            if (!rawEnd || isNaN(rawEnd.getTime())) {
                console.log(`Skipping "${event.title}" — invalid or missing endAt`);
                continue;
            }

            // Skip if event hasn't ended yet
            if (now <= rawEnd) continue;

            // Claim the event first to prevent duplicate emails
            // if the function runs twice at the same time
            try {
                await db.runTransaction(async (transaction) => {
                    const freshDoc = await transaction.get(eventDoc.ref);
                    if (freshDoc.data()?.feedbackRequestSent === true) {
                        throw new Error("already_claimed");
                    }
                    transaction.update(eventDoc.ref, { feedbackRequestSent: true });
                });
            } catch (e: any) {
                if (e?.message === "already_claimed") {
                    console.log(`Skipping "${event.title}" — already claimed`);
                    continue;
                }
                console.error(`Transaction failed for "${event.title}":`, e);
                continue;
            }

            console.log(`Sending feedback emails for: ${event.title}`);

            const participantsSnap = await db
                .collection(`events/${eventDoc.id}/participants`)
                .get();

            let allSent = true;

            for (const p of participantsSnap.docs) {
                const name = p.data().name;
                const email = p.data().email;

                if (email && email !== "-") {
                    const success = await sendEmail(name, email, event.title, eventDoc.id);
                    if (!success) allSent = false;
                }
            }

            if (allSent) {
                await eventDoc.ref.update({
                    feedbackRequestSentAt: new Date().toISOString(),
                });
                console.log(`Done with: ${event.title}`);
            } else {
                console.log(`Some emails failed for: ${event.title}`);
            }
        }

        return null;
    });