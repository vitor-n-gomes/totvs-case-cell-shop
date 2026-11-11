export enum PaymentType {
    Prepaid = "Prepaid",
    PostPaid = "Postpaid"
};


export enum Environment {
    Development = 'development',
    Prepord = 'Preprod',
    Prod = 'Prod'
};

export enum OrderStatus {
    Active = "Active",
    Cancelled = "Cancelled",
    Pending = "Pending"
};

export enum ProcessingStatus {
    PENDING = 'PENDING',
    PROCESSING = 'PROCESSING',
    RETRYING = 'RETRYING',
    COMPLETED = 'COMPLETED',
    FAILED = 'FAILED',
}