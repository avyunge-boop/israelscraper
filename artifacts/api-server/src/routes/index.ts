import { Router, type IRouter } from "express";
import healthRouter from "./health";
import busAlertsRouter from "./bus-alerts";

const router: IRouter = Router();

router.use(healthRouter);
router.use(busAlertsRouter);

export default router;
