/**
 *@class AppError -> Error type wrapper to allow custom error rather than a generic error message with call stack detail
 */
class AppError extends Error {
    constructor(
        readonly statusCode: number,
        message: string
    ){
        super(message);
        this.statusCode = statusCode
    }
}

export default AppError;