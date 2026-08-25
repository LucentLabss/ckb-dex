// Defines the preliminary bot-facing interface for identifying and handling DEX order cells.
import { OrderSchema } from "../models";
import { Config, Script } from "../types";

interface DexOrderBotTrait {
	readonly sort: () => {};
	scanForPendingOrders: () => {};
	executeTrade: () => {};
	markAsResolved: () => {};
	checkOrderLiveness: () => {};
	readonly pollInterval: number;
	readonly pendingPairOrders: typeof OrderSchema[];
	readonly deserializeLockScriptAndArgs: (script: Script) => Script;
	readonly config: Config;
	retryFailSwaps: () => {};
}



export default class DexOrderBot implements DexOrderBotTrait {


}
