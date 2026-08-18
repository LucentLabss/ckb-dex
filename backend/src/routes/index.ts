import express, {Request, Response} from "express";

const router = express().router;

router.get("/", (req: Request, res: Response) => {
    console.info("Order route request:", req);
    res.status(200).send("Order route reachable");
})

router.get("/trades", (req: Request, res: Response) => {
    console.info("Trade route request:", req);
    res.status(200).send("Trades route reachable");
})

export default router;