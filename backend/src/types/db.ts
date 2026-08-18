export interface DatabaseType {
    readonly mongodb_url: string;
    connect: () => void;
    disconnect: () => void;
}
