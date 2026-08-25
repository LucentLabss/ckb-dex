// Declares the minimal database connection interface used by the backend runtime.
export interface DatabaseType {
    readonly mongodb_url: string;
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
    isConnected: () => boolean;
}
