
async function processIncomingMessage(msg, contacts) {
    const from = msg.from;
    const wamid = msg.id; 
    
    const existing = await queryWithRetry('SELECT id FROM messages WHERE whatsapp_message_id = $1', [wamid]);
    if (existing.rows.length > 0) return;

    let text = '';
    let buttonId = null;
    
    if (msg.type === 'text') text = msg.text.body;
    else if (msg.type === 'button') text = msg.button.text; 
    else if (msg.type === 'interactive') {
        if (msg.interactive.type === 'button_reply') {
            text = msg.interactive.button_reply.title;
            buttonId = msg.interactive.button_reply.id; 
        } else if (msg.interactive.type === 'list_reply') {
            text = msg.interactive.list_reply.title;
            buttonId = msg.interactive.list_reply.id;
        }
    }

    const driverId = `d_${from}`; // Stabilize ID by phone number to prevent duplicates
    const name = contacts?.[0]?.profile?.name || 'Unknown Driver';
    
    // FIX: Force Bot ON for new drivers (INSERT), but preserve state for existing ones (UPDATE)
    const driverRes = await queryWithRetry(`
        INSERT INTO drivers (id, phone_number, name, status, last_message, last_message_time, updated_at, is_bot_active, is_human_mode, current_bot_step_id)
        VALUES ($1, $2, $3, 'New', $4, $5, $6, TRUE, FALSE, NULL)
        ON CONFLICT (phone_number) 
        DO UPDATE SET last_message = $4, last_message_time = $5, updated_at = $6
        RETURNING id, phone_number, current_bot_step_id, is_bot_active, is_human_mode
    `, [driverId, from, name, text, Date.now(), Date.now()]);
    
    const currentDriver = driverRes.rows[0];

    const msgId = `msg_${Date.now()}_in_${Math.random().toString(36).substr(2,5)}`;
    await queryWithRetry(`
        INSERT INTO messages (id, driver_id, sender, text, timestamp, whatsapp_message_id, status)
        VALUES ($1, $2, 'driver', $3, $4, $5, 'read')
    `, [msgId, currentDriver.id, text, Date.now(), wamid]);

    try {
        await runBotEngine(currentDriver, text, buttonId);
    } catch (e) {
        console.error("Bot Engine Crash:", e);
    }
}
