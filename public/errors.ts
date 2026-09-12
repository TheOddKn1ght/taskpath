export class RequestError extends Error {
  constructor(message:string, public status:number) { super(message); }
}
export const errorMessage = (error:unknown):string => error instanceof Error ? error.message : String(error);
export const errorStatus = (error:unknown):number | undefined => error instanceof RequestError ? error.status : undefined;
