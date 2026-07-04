import streamDeck from "@elgato/streamdeck";

import { MonitorBrightnessDial } from "./actions/monitor-brightness-dial";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new MonitorBrightnessDial());

streamDeck.connect();
