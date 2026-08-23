const express = require("express");
const cors = require("cors");
const fs = require("fs");
const QRCode = require("qrcode");
const { createClient } = require("@supabase/supabase-js");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const sessions = {}; // sessionId -> { sock, qr, status }

// Ek sessionId (jo whatsapp_credentials.id hota hai) se, us session ka
// asal "owner" (user_id) nikalta hai — taake har salon apna hi data dekhe
async function getUserIdForSession(sessionId) {
  const { data: cred } = await supabase
    .from("whatsapp_credentials")
    .select("user_id")
    .eq("id", sessionId)
    .maybeSingle();

  return cred?.user_id || null;
}

// Salon ki info + user_id (appointments save karne ke liye zaroori) nikalta hai.
// IMPORTANT: sessionId zaroor pass karo — warna galat (kisi aur) salon ki
// info mil sakti hai jab multiple salons app use kar rahe hon.
async function getSalonData(sessionId) {
  const userId = await getUserIdForSession(sessionId);
  if (!userId) {
    return { text: "Salon ki details abhi update nahi hui hain.", salon: null };
  }

  const { data: salon } = await supabase
    .from("salons")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (!salon) {
    return { text: "Salon ki details abhi update nahi hui hain.", salon: null };
  }

  const servicesText = (salon.services || [])
    .map((s) => `- ${s.name}: Rs. ${s.price}`)
    .join("\n");

  const text = `
Salon ka naam: ${salon.salon_name || "N/A"}
Timings: ${salon.opening_time || "N/A"} se ${salon.closing_time || "N/A"} tak
Services aur prices:
${servicesText || "Abhi koi service list nahi hai"}
Location: ${salon.address || "N/A"}
Phone: ${salon.phone || "N/A"}
Booking ke liye customer ko apna naam, date, aur time batana hota hai.
`;

  return { text, salon };
}

// Gemini se reply generate karta hai. Agar booking confirm ho chuki ho to
// reply ke end mein ek chupa hua <<<BOOKING>>>{...}<<<END>>> JSON block bhi aata hai.
async function generateAIReply(customerMessage, conversationHistory = [], sessionId) {
  const { text: salonInfo, salon } = await getSalonData(sessionId);

  const historyText = conversationHistory
    .map((m) => `${m.sender === "customer" ? "Customer" : "Tum"}: ${m.content}`)
    .join("\n");

  const todayStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  const promptText = `Tum "${salon?.salon_name || "is salon"}" ke WhatsApp assistant ho. Aaj ki date hai: ${todayStr}. Yahan salon ki puri jaankari hai:
${salonInfo}

Ab tak ki conversation:
${historyText}

Customer ne abhi ye naya message bheja hai: "${customerMessage}"

Iske baare mein Roman Urdu/Hinglish mein ek chota, friendly reply do. Sirf upar di gayi jaankari use karo — agar koi cheez info mein nahi hai to bolo "ye detail salon se confirm kar ke batati hoon".

AGAR is message ya conversation se customer ka naam, service, date, aur time — sab kuch confirm ho chuka hai (customer ne appointment book karne ki clear niyat zaahir ki hai), to apne reply ke bilkul END mein, ek nayi line par, is exact format mein ek JSON block bhi add karo (customer ko ye JSON nazar nahi aayega, hum ise nikaal denge):
<<<BOOKING>>>{"customer_name":"...","service_name":"...","appointment_date":"YYYY-MM-DD","appointment_time":"HH:MM"}<<<END>>>

Agar abhi booking confirm nahi hui (koi detail missing hai), to ye JSON block bilkul mat likho — sirf normal reply do.
Relative dates jaise "kal", "parso", "aaj" ko upar di gayi aaj ki date (${todayStr}) ke hisaab se actual date mein convert karo.
Reply ka normal text plain ho, koi markdown nahi.`;

  // Gemini ko call karta hai. Agar pehli koshish fail ho jaye (jaise server busy/503),
  // to 2 second wait karke ek baar aur try karta hai, taake temporary glitch se
  // customer ka reply na ruk jaye.
  async function callGemini() {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
        }),
      }
    );

    const data = await response.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return { data, reply };
  }

  let { data, reply } = await callGemini();
  console.log("GEMINI RAW RESPONSE:", JSON.stringify(data));

  if (!reply) {
    console.log("Gemini pehli koshish mein fail hui, 2 second baad dobara try kar rahe hain...");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const retryResult = await callGemini();
    data = retryResult.data;
    reply = retryResult.reply;
    console.log("GEMINI RETRY RESPONSE:", JSON.stringify(data));
  }

  return { rawReply: reply || "Sorry, thodi der mein reply karte hain.", salon };
}

// Gemini ke reply se <<<BOOKING>>>{...}<<<END>>> block nikaal ke alag karta hai
function extractBooking(rawReply) {
  const match = rawReply.match(/<<<BOOKING>>>([\s\S]*?)<<<END>>>/);
  if (!match) return { cleanText: rawReply.trim(), booking: null };

  const cleanText = rawReply.replace(match[0], "").trim();
  let booking = null;
  try {
    booking = JSON.parse(match[1]);
  } catch (e) {
    console.log("Booking JSON parse fail hui:", e.message);
  }
  return { cleanText, booking };
}

// Har connected salon (session) ke liye ALAG ALAG check karta hai —
// taake Salon A ke appointments ka reminder galti se Salon B ke number se na chala jaye.
async function checkAndSendReminders() {
  const now = new Date();

  for (const sessionId in sessions) {
    const session = sessions[sessionId];
    if (session.status !== "connected") continue;

    const userId = await getUserIdForSession(sessionId);
    if (!userId) continue;

    const { data: salon } = await supabase
      .from("salons")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    const salonName = salon?.salon_name || "Salon";

    const { data: appointments } = await supabase
      .from("appointments")
      .select("*")
      .eq("user_id", userId)
      .in("status", ["pending", "confirmed"]);

    if (!appointments || appointments.length === 0) continue;

    for (const appt of appointments) {
      if (!appt.appointment_date || !appt.appointment_time) continue;

      const apptDateTime = new Date(`${appt.appointment_date}T${appt.appointment_time}`);
      const diffHours = (apptDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);

      // 1 din pehle wala reminder (23-25 ghante ka window)
      if (!appt.reminder_day_sent && diffHours <= 25 && diffHours > 23) {
        const text = `Assalam o alaikum ${appt.customer_name}! Ye ek pyara sa reminder hai ke KAL ${salonName} mein aapki "${appt.service_name || "appointment"}" hai, waqt: ${appt.appointment_time.slice(0, 5)}. Milte hain! 😊`;
        const jid = `${appt.customer_phone}@s.whatsapp.net`;
        try {
          await session.sock.sendMessage(jid, { text });
          await supabase.from("appointments").update({ reminder_day_sent: true }).eq("id", appt.id);
          console.log(`📅 1-din-pehle reminder bheja (${salonName}): ${appt.customer_name}`);
        } catch (e) {
          console.log("Reminder bhejne mein error:", e.message);
        }
      }

      // Kuch ghante pehle wala reminder (2-3 ghante ka window)
      if (!appt.reminder_hour_sent && diffHours <= 3 && diffHours > 2) {
        const text = `Assalam o alaikum ${appt.customer_name}! Bas yaad dila rahe hain — thodi der mein ${salonName} mein aapki "${appt.service_name || "appointment"}" hai, waqt: ${appt.appointment_time.slice(0, 5)}. Intezar rahega!`;
        const jid = `${appt.customer_phone}@s.whatsapp.net`;
        try {
          await session.sock.sendMessage(jid, { text });
          await supabase.from("appointments").update({ reminder_hour_sent: true }).eq("id", appt.id);
          console.log(`⏰ Kuch-ghante-pehle reminder bheja (${salonName}): ${appt.customer_name}`);
        } catch (e) {
          console.log("Reminder bhejne mein error:", e.message);
        }
      }
    }
  }
}

// Har 15 minute mein reminders check karta rehta hai
function startReminderScheduler() {
  setInterval(checkAndSendReminders, 15 * 60 * 1000); // 15 minute
  checkAndSendReminders(); // service start hote hi ek dafa turant bhi check kar le
}

async function findOrCreateConversation(sessionId, customerNumber, userId) {
  const { data: existing } = await supabase
    .from("conversations")
    .select("*")
    .eq("whatsapp_credential_id", sessionId)
    .eq("customer_number", customerNumber)
    .maybeSingle();

  if (existing) return existing;

  const { data: created } = await supabase
    .from("conversations")
    .insert({ whatsapp_credential_id: sessionId, customer_number: customerNumber, user_id: userId })
    .select()
    .single();

  return created;
}

async function startSession(sessionId) {
  const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${sessionId}`);

  const sock = makeWASocket({ auth: state, printQRInTerminal: false });
  sessions[sessionId] = { sock, qr: null, status: "connecting" };

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessions[sessionId].qr = await QRCode.toDataURL(qr);
      sessions[sessionId].status = "qr_ready";
    }

    if (connection === "open") {
      sessions[sessionId].status = "connected";
      await supabase
        .from("whatsapp_credentials")
        .update({ status: "connected", connection_type: "qr" })
        .eq("id", sessionId);
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      sessions[sessionId].status = "disconnected";
      if (shouldReconnect) startSession(sessionId);
    }
  });

  // Naya message aane pe Supabase mein save karo, phir AI se reply bhejo
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const customerNumber = msg.key.remoteJid;
    const text =
      msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";

    if (!text) return;

    // Ye session (sessionId) kis salon/user ka hai, wo pehle nikal lo —
    // taake aage har insert sahi owner ke saath ho
    const userId = await getUserIdForSession(sessionId);

    const conversation = await findOrCreateConversation(sessionId, customerNumber, userId);

    await supabase.from("messages").insert({
      conversation_id: conversation.id,
      sender: "customer",
      content: text,
      user_id: userId,
    });

    await supabase
      .from("conversations")
      .update({ last_message: text, last_message_at: new Date().toISOString() })
      .eq("id", conversation.id);

    // AI se reply generate karo aur customer ko wapas bhejo
    const { data: pastMessages } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: true });

    const { rawReply, salon } = await generateAIReply(text, pastMessages || [], sessionId);
    const { cleanText: aiReply, booking } = extractBooking(rawReply);

    await sock.sendMessage(customerNumber, { text: aiReply });

    await supabase.from("messages").insert({
      conversation_id: conversation.id,
      sender: "ai",
      content: aiReply,
      user_id: userId,
    });

    await supabase
      .from("conversations")
      .update({ last_message: aiReply, last_message_at: new Date().toISOString() })
      .eq("id", conversation.id);

    // Agar booking confirm hui hai (naam + date + time mil gaye), appointments table mein save karo
    if (
      booking &&
      salon &&
      booking.customer_name &&
      booking.appointment_date &&
      booking.appointment_time
    ) {
      // customerNumber JID jaisa hota hai "923001234567:12@s.whatsapp.net"
      // pehle "@" se pehle wala hissa lo, phir ":" se pehle wala (device suffix hata do)
      const phoneNumber = customerNumber.split("@")[0].split(":")[0];
      const { error: bookingError } = await supabase.from("appointments").insert({
        user_id: salon.user_id,
        customer_name: booking.customer_name,
        customer_phone: phoneNumber,
        service_name: booking.service_name || null,
        appointment_date: booking.appointment_date,
        appointment_time: booking.appointment_time,
        status: "pending",
      });

      if (bookingError) {
        console.log("Appointment save karne mein error:", bookingError.message);
      } else {
        console.log("✅ Appointment WhatsApp se save ho gayi:", booking.customer_name);
      }
    }
  });
}

// Meta Cloud API ke zariye message bhejta hai
async function sendViaMeta(phoneNumberId, apiKey, to, text) {
  await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
}

// Meta ye webhook ek dafa call karta hai jab salon owner Meta App Dashboard mein
// webhook URL set karta hai — sirf verify karna hota hai, koi customer data nahi
app.get("/webhook/meta", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Jab bhi koi customer Meta-connected number par WhatsApp message bheje,
// Meta khud is address par bhej deta hai
app.post("/webhook/meta", async (req, res) => {
  res.sendStatus(200); // Meta ko turant "mil gaya" bata do, warna wo baar baar retry karega

  try {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = change?.messages?.[0];
    if (!message || message.type !== "text") return;

    const customerNumber = message.from; // jaise "923001234567"
    const text = message.text?.body || "";
    const phoneNumberId = change?.metadata?.phone_number_id;

    // Kis salon ka number hai, wo dhoondo (phone_number_id se match karke)
    const { data: cred } = await supabase
      .from("whatsapp_credentials")
      .select("*")
      .eq("connection_type", "api_key")
      .eq("provider", "meta")
      .eq("phone_number_id", phoneNumberId)
      .maybeSingle();

    if (!cred || !cred.api_key) {
      console.log("Meta webhook: is phone_number_id ke liye koi connected salon nahi mila");
      return;
    }

    const conversation = await findOrCreateConversation(cred.id, `${customerNumber}@meta`, cred.user_id);

    await supabase.from("messages").insert({
      conversation_id: conversation.id,
      sender: "customer",
      content: text,
      user_id: cred.user_id,
    });
    await supabase
      .from("conversations")
      .update({ last_message: text, last_message_at: new Date().toISOString() })
      .eq("id", conversation.id);

    const { data: pastMessages } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: true });

    const { rawReply, salon } = await generateAIReply(text, pastMessages || [], cred.id);
    const { cleanText: aiReply, booking } = extractBooking(rawReply);

    await sendViaMeta(cred.phone_number_id, cred.api_key, customerNumber, aiReply);

    await supabase.from("messages").insert({
      conversation_id: conversation.id,
      sender: "ai",
      content: aiReply,
      user_id: cred.user_id,
    });
    await supabase
      .from("conversations")
      .update({ last_message: aiReply, last_message_at: new Date().toISOString() })
      .eq("id", conversation.id);

    if (
      booking &&
      salon &&
      booking.customer_name &&
      booking.appointment_date &&
      booking.appointment_time
    ) {
      const { error: bookingError } = await supabase.from("appointments").insert({
        user_id: salon.user_id,
        customer_name: booking.customer_name,
        customer_phone: customerNumber,
        service_name: booking.service_name || null,
        appointment_date: booking.appointment_date,
        appointment_time: booking.appointment_time,
        status: "pending",
      });
      if (bookingError) {
        console.log("Appointment save karne mein error (Meta):", bookingError.message);
      } else {
        console.log("✅ Appointment Meta WhatsApp se save ho gayi:", booking.customer_name);
      }
    }
  } catch (e) {
    console.log("Meta webhook process karne mein error:", e.message);
  }
});

// Naya connection shuru karo
app.post("/connect/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  if (!sessions[sessionId]) await startSession(sessionId);
  res.json({ status: "started" });
});

// Connection status check karo
app.get("/status/:sessionId", (req, res) => {
  const session = sessions[req.params.sessionId];
  if (!session) return res.json({ status: "not_connected" });
  res.json({ status: session.status, qr: session.qr });
});

// Connection reset/disconnect karo — purani session poori tarah saaf karta hai
// taake fresh QR code se dobara connect ho sake
app.post("/disconnect/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  // Agar session memory mein active hai, socket band karo
  const session = sessions[sessionId];
  if (session?.sock) {
    try {
      await session.sock.logout();
    } catch (e) {
      console.log("Logout ke waqt error (ignore kar sakte hain):", e.message);
    }
  }
  delete sessions[sessionId];

  // Session ki auth files disk se delete karo
  const sessionFolder = `./sessions/${sessionId}`;
  if (fs.existsSync(sessionFolder)) {
    fs.rmSync(sessionFolder, { recursive: true, force: true });
  }

  // Database mein status wapas "not_connected" kar do
  await supabase
    .from("whatsapp_credentials")
    .update({ status: "not_connected" })
    .eq("id", sessionId);

  res.json({ status: "disconnected" });
});

// Message bhejo (QR aur Meta API, dono tareekon ke liye kaam karta hai)
app.post("/send/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { to, text } = req.body;

  const { data: cred } = await supabase
    .from("whatsapp_credentials")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (cred?.connection_type === "api_key" && cred.provider === "meta") {
    // Meta Cloud API se connected salon
    try {
      const rawNumber = to.replace("@meta", "").replace("@s.whatsapp.net", "");
      await sendViaMeta(cred.phone_number_id, cred.api_key, rawNumber, text);
    } catch (e) {
      return res.status(500).json({ error: "Meta se message bhejne mein error: " + e.message });
    }
  } else {
    // QR (Baileys) se connected salon
    const session = sessions[sessionId];
    if (!session || session.status !== "connected") {
      return res.status(400).json({ error: "Session connected nahi hai" });
    }
    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    await session.sock.sendMessage(jid, { text });
  }

  const conversation = await findOrCreateConversation(sessionId, to, cred?.user_id || null);
  await supabase.from("messages").insert({
    conversation_id: conversation.id,
    sender: "salon",
    content: text,
    user_id: cred?.user_id || null,
  });
  await supabase
    .from("conversations")
    .update({ last_message: text, last_message_at: new Date().toISOString() })
    .eq("id", conversation.id);

  res.json({ sent: true });
});

// Server start hote hi purani sessions wapas connect karo (restart ke baad dobara QR na scan karna pade)
function restoreSessions() {
  if (!fs.existsSync("./sessions")) return;
  const sessionFolders = fs.readdirSync("./sessions");
  sessionFolders.forEach((sessionId) => {
    console.log(`Purani session wapas connect kar rahe hain: ${sessionId}`);
    startSession(sessionId);
  });
}

app.listen(process.env.PORT || 4000, () => {
  console.log(`Baileys service chal raha hai port ${process.env.PORT || 4000} pe`);
  restoreSessions();
  startReminderScheduler();
});