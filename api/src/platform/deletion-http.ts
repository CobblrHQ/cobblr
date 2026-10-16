import type { Request, Response, NextFunction } from "express";
import { captureDelete } from "./deleted-records.js";

class RefusedDelete extends Error {}

export async function captureHttpDelete(req: Request, res: Response, next: NextFunction, kind: string, id: string): Promise<void> {
  const end = res.end.bind(res);
  let answer: unknown[] | undefined;
  try {
    const captured = await captureDelete(req.tenant!.org.id, kind, id, () => new Promise<void>((resolve, reject) => {
      res.end = ((...args: unknown[]) => {
        answer = args;
        if (res.statusCode >= 300) reject(new RefusedDelete());
        else resolve();
        return res;
      }) as Response["end"];
      res.once("close", () => { if (!answer) reject(new RefusedDelete()); });
      next();
    }));
    if (captured.deletionId) res.setHeader(/* PRODUCT-NAME: A wire protocol header shared by existing clients and servers. */ "X-Cobblr-Deleted-Record", captured.deletionId);
    res.end = end;
    if (answer) Reflect.apply(end, res, answer);
  } catch (err) {
    res.end = end;
    if (err instanceof RefusedDelete) { if (answer) Reflect.apply(end, res, answer); }
    else next(err);
  }
}
