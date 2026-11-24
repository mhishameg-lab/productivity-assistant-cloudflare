export const VOICE_BANK = {
  greeting_morning: [
    "Good morning, {name}. Let's get it.",
    "Morning, {name}. Fresh day, clean slate."
  ],
  greeting_weekend_morning: ["Happy {weekday}, {name}. Chill, but let's not waste the morning."],
  tier1: [
    "Yo {name}, “{task}” is up next. 25 minutes, let's get it.",
    "Easy work, bro. Just start “{task}”. Even 5 minutes counts.",
    "Lowkey “{task}” is the move right now. You in?",
    "We're good, {name}. One small rep on “{task}” and you're rolling."
  ],
  tier2: [
    "Bro, “{task}” has been sitting there all day. It's lonely. 😏",
    "Not to be dramatic, but “{task}” will not do itself, {name}.",
    "{n} pings and nothing? Okay, I see you. Timer's ready when you are. 😏",
    "Your to-do list is kinda loud rn. Let's shut it up with 25 minutes.",
    "Ngl, “{task}” is giving 'I'll do it tomorrow' energy. Prove me wrong. 😏"
  ],
  tier3: [
    "{name}, “{task}” is {n} days late. No more games. 25 minutes, right now.",
    "Real talk: this one's been dodged long enough. Start it or give it a real date.",
    "Comfort feels good, progress feels better. “{task}”, 25 minutes, let's go.",
    "Two options: start “{task}” or move it with a real date. Ghosting it isn't one."
  ],
  tierC: [
    "You've been quiet, {name}. All good? Want me to chill for 2 hours?",
    "Rough patch? No stress. Shrink “{task}” to the tiniest step: just open it.",
    "Don't gotta feel ready. Hit start anyway, or take a breather and come back.",
    "Take 5: water, stretch, reset. Then we pick one small thing."
  ],
  done_one: [
    "Let's gooo. “{task}” is done. 💪",
    "W. One more off the list, {name}."
  ],
  done_all_three: ["Three for three, {name}. 🎉 Now go rest, you earned it."],
  care_water: ["💧 Water check, bro."],
  care_food: ["🍽 Ate yet? Real food, not just coffee."],
  care_break: ["🧘 Two minutes off the screen. I'll hold it down."],
  sleep_prompt: ["Alright {name}, time to power down. 🌙 When should I wake you?"],
  sleep_confirmed: ["Locked in. I'll wake you at {time} ⏰ (that's {duration} from now). I'm staying quiet till then. Set a real alarm too, I'm just a notification."],
  sleep_wake: ["☀️ Rise and shine, {name}. It's {time}. Ready to get after it?"],
  sleep_reping_2: ["Yo, still out? It's {time}. Tap once and I'll stop."],
  sleep_reping_3: ["Last call, bro. {time}. Water first, then we start small."],
  sleep_early: ["Oh you're up already. Sleep mode off. Want to go back to bed?"],
  dive_start: ["Bet. 🎧 I'm gone for {hours}. I'll hit you at {time}."],
  dive_extend: ["Added {minutes} min. Back at {time}."],
  dive_end: ["🎧 Time's up, {name}. Welcome back. What was the win?"],
  dive_end_late: ["🎧 You're back. Here's where things stand."],
  reminder_set: ["Got it. I'll remind you to “{text}” at {time}. ⏰"],
  reminder_needs_time: ["When should I remind you?"],
  reminder_due: ["⏰ <b>{text}</b>"],
  reminder_snoozed: ["Snoozed till {time}."],
  reminder_second_ping: ["⏰ Still on this one: {text}"],
  reminder_held: ["⏰ While you were asleep: {text}"],
  google_down: ["Google Tasks didn't answer, so I won't show you old info. Try again in a minute."],
  nothing_overdue: ["Nothing overdue. 🎉"],
  tasks_clear: ["Your task list is clear. Add something, or take the win?"],
  no_plan_today: ["Your three outcomes for today aren't set yet. Takes about a minute."],
  outcome_suggestion: ["💡 Suggested: {task}"],
  day_load_warning: ["Heads-up: {n} tasks are due today. That's a lot. Pick the 1–3 that matter most."]
};
