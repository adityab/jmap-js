// -------------------------------------------------------------------------- \\
// File: Message.js                                                           \\
// Module: MailModel                                                          \\
// Requires: API, Mailbox.js                                                  \\
// Author: Neil Jenkins                                                       \\
// License: © 2010-2015 FastMail Pty Ltd. MIT Licensed.                       \\
// -------------------------------------------------------------------------- \\

/*global O, JMAP */

"use strict";

( function ( JMAP, undefined ) {

var Status = O.Status,
    EMPTY = Status.EMPTY,
    READY = Status.READY,
    NEW = Status.NEW;

var Record = O.Record,
    attr = Record.attr;

var MessageDetails = O.Class({ Extends: Record });

var Message = O.Class({

    Extends: Record,

    threadId: attr( String ),

    thread: function () {
        var threadId = this.get( 'threadId' );
        return threadId ?
            this.get( 'store' ).getRecord( JMAP.Thread, threadId ) : null;
    }.oProperty( 'threadId' ).nocache(),

    mailboxes: Record.toMany({
        recordType: JMAP.Mailbox,
        key: 'mailboxIds'
    }),

    isUnread: attr( Boolean ),
    isFlagged: attr( Boolean ),
    isAnswered: attr( Boolean ),
    isDraft: attr( Boolean ),
    hasAttachment: attr( Boolean ),

    from: attr( Object ),
    to: attr( Array ),
    subject: attr( String ),
    date: attr( Date ),

    size: attr( Number ),

    preview: attr( String ),

    // ---

    isIn: function ( role ) {
        return this.get( 'mailboxes' ).some( function ( mailbox ) {
            return mailbox.get( 'role' ) === role;
        });
    },
    isInTrash: function () {
        return this.isIn( 'trash' );
    }.oProperty( 'mailboxes' ),

    notifyThread: function () {
        var threadId = this.get( 'threadId' ),
            store = this.get( 'store' );
        if ( threadId &&
                ( store.getRecordStatus( JMAP.Thread, threadId ) & READY ) ) {
            this.get( 'thread' ).propertyDidChange( 'messages' );
        }
    }.queue( 'before' ).observes( 'mailboxes',
        'isUnread', 'isFlagged', 'isDraft', 'hasAttachment' ),

    // ---

    fromName: function () {
        var from = this.get( 'from' );
        return from ? from.name || from.email.split( '@' )[0] : '';
    }.oProperty( 'from' ),

    fromEmail: function () {
        var from = this.get( 'from' );
        return from ? from.email : '';
    }.oProperty( 'from' ),

    // ---

    detailsStatus: function ( status ) {
        if ( status !== undefined ) {
            return status;
        }
        if ( this.get( 'blobId' ) || this.is( NEW ) ) {
            return READY;
        }
        return EMPTY;
    }.oProperty( 'blobId' ),

    fetchDetails: function () {
        if ( this.get( 'detailsStatus' ) === EMPTY ) {
            JMAP.mail.fetchRecord( MessageDetails, this.get( 'id' ) );
        }
    },

    blobId: attr( String ),

    inReplyToMessageId: attr( String ),

    headers: attr( Object, {
        defaultValue: {}
    }),

    cc: attr( Array ),
    bcc: attr( Array ),
    replyTo: attr( Object ),

    textBody: attr( String ),
    htmlBody: attr( String ),

    attachments: attr( Array ),
    attachedMessages: attr( Object ),
    attachedInvites: attr( Object )
}).extend({
    headerProperties: [
        'threadId',
        'mailboxIds',
        'isUnread',
        'isFlagged',
        'isAnswered',
        'isDraft',
        'hasAttachment',
        'from',
        'to',
        'subject',
        'date',
        'size',
        'preview'
    ],
    detailsProperties: [
        'blobId',
        'inReplyToMessageId',
        'headers.List-Id',
        'headers.List-Post',
        'cc',
        'bcc',
        'replyTo',
        'body',
        'attachments',
        'attachedMessages',
        'attachedInvites'
    ],
    Details: MessageDetails
});

JMAP.mail.handle( MessageDetails, {
    fetch: function ( ids ) {
        this.callMethod( 'getMessages', {
            ids: ids,
            properties: Message.detailsProperties
        });
    }
});

JMAP.mail.messageUpdateFetchRecords = true;
JMAP.mail.messageUpdateMaxChanges = 50;
JMAP.mail.handle( Message, {
    fetch: function ( ids ) {
        this.callMethod( 'getMessages', {
            ids: ids,
            properties: Message.headerProperties
        });
    },
    refresh: function ( ids, state ) {
        if ( ids ) {
            this.callMethod( 'getMessages', {
                ids: ids,
                properties: [
                    'mailboxIds',
                    'isUnread',
                    'isFlagged',
                    'isAnswered',
                    'isDraft',
                    'hasAttachment'
                ]
            });
        } else {
            var messageUpdateFetchRecords = this.messageUpdateFetchRecords;
            this.callMethod( 'getMessageUpdates', {
                sinceState: state,
                maxChanges: this.messageUpdateMaxChanges,
                fetchRecords: messageUpdateFetchRecords,
                fetchRecordProperties: messageUpdateFetchRecords ?
                    Message.headerProperties : null
            });
        }
    },
    commit: 'setMessages',

    // ---

    messages: function ( args ) {
        var first = args.list[0],
            updates;
        if ( first && first.date ) {
            this.didFetch( Message, args );
        } else {
            updates = args.list.reduce( function ( updates, message ) {
                updates[ message.id ] = message;
                return updates;
            }, {} );
            this.get( 'store' )
                .sourceDidFetchPartialRecords( Message, updates );
        }
    },
    messageUpdates: function ( args, _, reqArgs ) {
        this.didFetchUpdates( Message, args, reqArgs );
        if ( !reqArgs.fetchRecords ) {
            this.recalculateAllFetchedWindows();
        }
        if ( args.hasMoreUpdates ) {
            var messageUpdateMaxChanges = this.messageUpdateMaxChanges;
            if ( messageUpdateMaxChanges < 150 ) {
                if ( messageUpdateMaxChanges === 50 ) {
                    // Keep fetching updates, just without records
                    this.messageUpdateFetchRecords = false;
                    this.messageUpdateMaxChanges = 100;
                } else {
                    this.messageUpdateMaxChanges = 150;
                }
                this.get( 'store' ).fetchAll( Message, true );
                return;
            } else {
                // We've fetched 300 updates and there's still more. Let's give
                // up and reset.
                this.response
                    .error_getMessageUpdates_cannotCalculateChanges
                    .call( this, args );
            }
        }
        this.messageUpdateFetchRecords = true;
        this.messageUpdateMaxChanges = 50;
    },
    error_getMessageUpdates_cannotCalculateChanges: function ( args ) {
        var store = this.get( 'store' );
        // All our data may be wrong. Mark all messages as obsolete.
        // The garbage collector will eventually clean up any messages that
        // no longer exist
        store.getAll( Message ).forEach( function ( message ) {
            message.setObsolete();
        });
        this.recalculateAllFetchedWindows();
        // Tell the store we're now in the new state.
        store.sourceDidFetchUpdates(
            Message, null, null, store.getTypeState( Message ), args.newState );

    },
    messagesSet: function ( args ) {
        this.didCommit( Message, args );
    }
});

JMAP.Message = Message;

}( JMAP ) );
