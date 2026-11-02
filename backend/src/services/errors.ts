export class ServiceError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
