import axios from 'axios'
import { EventEmitter } from 'events'
import dispatcher from './dispatcher'
import schemaStore from './schemaStore'
import ast from './astUtils'
import parser from 'js-sql-parser'


class QueryStore extends EventEmitter {
  constructor() {
    super()
    this.query = null
    this.errorLog = ""

    schemaStore.on("filtering-toggled", () => {
      const isFilteringChecked = schemaStore.getFiltering()
      //If filtering was unchecked, remove the where clause
      if(!isFilteringChecked && this.query !== null) {
        this.query.value.where = null;
        setTimeout(() => { this.emit("query-updated") })  // Avoids dispatcher invariant issues
      }
    })

    schemaStore.on("grouping-toggled", () => {
      if(this.query !== null) {
        const isGroupingChecked = schemaStore.getGrouping()
        if(isGroupingChecked) {
          this.query = ast.addAllGrouping(this.query)
        } else {
          this.query = ast.removeAllGrouping(this.query)
        }
        setTimeout(() => { this.emit("query-updated") })  // Avoids dispatcher invariant issues
      }

    })

    schemaStore.on("ordering-toggled", () => {
      const isOrderingChecked = schemaStore.getOrdering()

      if(!isOrderingChecked && this.query !== null) {
        this.query = ast.removeAllOrderByColumns(this.query)
        setTimeout(() => { this.emit("query-updated") })  // Avoids dispatcher invariant issues
      }
    })
  }

  setError(errorLog) {
    const posMatch = errorLog.match(/(-*)\^/)
    const errorPos = posMatch === null ? 0 : posMatch[1].length
    this.errorLog = errorLog.substring(0, errorLog.indexOf("Expecting")).replace(/\son\sline\s[0-9]+/i, '').replace(/-*\^/, '').toLowerCase()
    this.emit("parse-error", errorPos)
  }

  getErrorLog() {
    return this.errorLog
  }

  addColumn(col) {
    const table = col.split(".")[0]
    const column = col.split(".")[1]

    if(!this.query){
      this.query = parser.parse("SELECT " + column + " FROM " + table)
      if(schemaStore.getGrouping()) this.query = ast.addAllGrouping(this.query)
    } else {
      const currTables = ast.getTables(this.query, [])
      const currColumns = ast.getColumns(this.query, [], false) //return all the column names (unwrapped)

      //Check if the column is already listed on the 'select' list (or is star)
      if(column === "*" || currColumns.indexOf(column) === -1) {
        this.query = ast.addSelectColumn(this.query, column, table)
      }

      //Check if the table is already on the 'from' list
      if(currTables.indexOf(table) === -1) {
        this.query = ast.addNaturalJoinTable(this.query, table)
      }
    }

    setTimeout(() => { this.emit("query-updated") })  // Avoids dispatcher invariant issues
  }

  removeColumn(colIdx) {
    this.query = ast.removeSelectColumn(this.query, colIdx)
    setTimeout(() => { this.emit("query-updated") })  // Avoids dispatcher invariant issues
  }

  filterColumn(column, operator, value) {
    this.query = ast.removeWhereColumn(this.query, column, operator)

    if(value.length) {
      value = operator === "like" ? "'" + value + "%'" : parseInt(value)
      this.query = ast.addWhereColumn(this.query, column, operator, value)
    }
    setTimeout(() => { this.emit("query-updated") })  // Avoids dispatcher invariant issues
  }

  groupColumn(colIdx, func, colType){
    this.query = ast.addGroupByColumn(this.query, colIdx, func, colType)
    setTimeout(() => { this.emit("query-updated") })  // Avoids dispatcher invariant issues
  }

  getGroupByColumn(column) {
    return ast.getGroupByColumn(column)
  }

  orderColumn(colIdx, order, sort){
    // First remove ordering by this column if it's present
    this.query = ast.removeOrderByColumn(this.query, colIdx)
    // Now add it again
    this.query = ast.addOrderByColumn(this.query, colIdx, order, sort)
    setTimeout(() => { this.emit("query-updated") })  // Avoids dispatcher invariant issues
  }

  getOrderFromColumn(colIdx) {
    let order = ast.getOrderByColumnIdx(this.query, colIdx)
    order.order = order.order === null ? "" : order.order.toString()
    order.sort = order.sort === null ? "asc" : order.sort.toLowerCase()
    return order
  }

  getWhereForColumn(column, columnType) {
    const whereNode = ast.getWhereColumn(this.query, column, columnType)
    let operator = ""
    let value = ""
    if(whereNode !== null) {
      operator = whereNode.type == "LikePredicate" ? "like" : whereNode.operator
      value = whereNode.type == "LikePredicate" ? whereNode.right.value.match(/^'%?([^%]*)%?'$/)[1] : whereNode.right.value
    }

    return { operator, value }
  }

  parseQuery(queryStr){
    try {
      this.query = queryStr.length ? parser.parse(queryStr) : null

      if(this.query !== null){
        const isWrapped = ast.getColumns(this.query, [], true).reduce((anyWrapped, colStr) => {
          const funcMatch = colStr.match(/([a-zA-Z]+)\((.+)\)/)
          const currWrapped = (funcMatch !== null && ['avg', 'sum', 'min', 'max', 'count'].indexOf(funcMatch[1].toLowerCase()) > -1)
          return anyWrapped || currWrapped
        }, false)
        const isGrouped = isWrapped || this.query.value.groupBy !== null
        if(!isGrouped && schemaStore.getGrouping()) {
          dispatcher.dispatch({ type:"TOGGLE_GROUPING", checked:false })
        }
      }
      this.emit("query-parsed");
      return true
    } catch(error){
      this.setError(error.message)
      console.error("PARSE ERROR", error.message);
      return false
    }
  }

  getColumns(){
    return this.query ? ast.getColumns(this.query, [], true) : []
  }

  getQueryString() {
    console.log(this.query)
    return this.query ? parser.stringify(this.query).trim() : ""
  }

  getErrorHTML(str, errorClass, errorPos){
    let query = typeof str === "undefined" ?  this.getQueryString() : str
    errorPos = errorPos > query.length ? 0 : errorPos
    //Add error tags and return
    let errorQuery = query.substring(0, errorPos).replace(/\s/g, '&nbsp;') + '<span class="' + errorClass + '">' + query.substring(errorPos).replace(/\s/g, '&nbsp;')
    return '<p>' + errorQuery + '</span></p>'
  }

  getQueryHTML(str) {
    let selectKeyword, selectClause, fromKeyword, fromClause
    let optionalClauses = [{},{},{},{}]
    let query = typeof str === "undefined" ?  this.getQueryString() : str
    let queryTree = null
    // console.log("INPUT STRING:", query)

    //Is there a query?
    if(query.length === 0) return '<p></p>'

    // Is the query parsable?
    try {
        queryTree = parser.parse(query)
    // If not parsable, just return an error
    } catch(error) {
        this.setError(error.message)
        const posMatch = error.message.match(/(-*)\^/)
        const errorPos = posMatch === null ? query.length : posMatch[1].length
        return this.getErrorHTML(query, "warning", errorPos)
    }

    // Escape Spaces
    let escapedQuery = query.replace(/\s/g, '&nbsp;')

    // I should get an automatic A just for coming up with this RegEx...
    const queryMatch = escapedQuery.match(/(select)(.*?)(from)(?:(.*?)(where|group(?:&nbsp;)+by|having|order(?:&nbsp;)+by)|(.*))(?:(.*?)(group(?:&nbsp;)+by|having|order(?:&nbsp;)+by)|(.*))(?:(.*?)(having|order(?:&nbsp;)+by)|(.*))(?:(.*?)(order(?:&nbsp;)+by)|(.*))(.*)/i);

    // Is this a valid SQL query based on the regex?
    if(queryMatch === null) return '<p>' + escapedQuery + '</p>' // No matches... this is not a valid sql query, so just return it

    //First let's color the keywords
    selectKeyword =  queryMatch[1] ? '<span class="clause select">SELECT</span>' : '';
    selectClause = queryMatch[2] ? queryMatch[2] : '';
    fromKeyword =  queryMatch[3] ? '<span class="clause select">FROM</span>' : '';
    fromClause =  queryMatch[6] ? queryMatch[6] : queryMatch[4] ? queryMatch[4] : '';

    optionalClauses.forEach((optional, i) => {
      let offset = i*3
      optional.class = queryMatch[5+offset] ? queryMatch[5+offset].toLowerCase().replace(/(&nbsp;)+/g, '-') : '';
      optional.keyword =  queryMatch[5+offset] ? '<span class="clause ' + optional.class + '">' + queryMatch[5+offset].replace(/(&nbsp;)+/g, ' ').toUpperCase() + '</span>' : '';
      optional.clause =  queryMatch[9+offset] ? queryMatch[9+offset] : queryMatch[7+offset] ? queryMatch[7+offset] : '';
    })

    // Now let's add color to the columns
    if(queryTree) {
      let currColumns = []
      //First get the raw group by columns
      // if(queryTree.value && queryTree.value.groupBy) currColumns = ast.getRawColumns(queryTree.value.groupBy.value.map(c => c.value), currColumns)
      //Then get the raw order by columns
      // if(queryTree.value && queryTree.value.orderBy) currColumns = ast.getRawColumns(queryTree.value.orderBy.value.map(c => c.value), currColumns)
      //Now get the raw select columns
      if(queryTree.value && queryTree.value.selectItems) currColumns = ast.getRawColumns(queryTree.value.selectItems.value, currColumns).map(c => {let arr = c.split('.'); return arr[arr.length-1]})
      // Now join regular columns with expanded columns
      currColumns = ast.getColumns(queryTree, currColumns, true)
      //Finally, turn it into a string that can be used in the regex
      currColumns = currColumns.reduce((str, c) => str + "|" + c,  "").substring(1).replace('*', '\\*')
      let colRegex = new RegExp('(\\s|\\.)(' + currColumns + ')(\\s|,|$)', 'gi')
      console.log(colRegex)
      selectClause = selectClause.replace(/&nbsp;/g, ' ').replace(colRegex, '$1<span class="column select">$2</span>$3').replace(/\s(?![^<]*>)/g, '&nbsp;');
      optionalClauses.forEach((optional, i) => {
        optional.clause = optional.clause.replace(/&nbsp;/g, ' ').replace(colRegex, '$1<span class="column ' + optional.class + '">$2</span>$3').replace(/\s(?![^<]*>)/g, '&nbsp;');
      })
    }

    //Finally, let's color the aggregate functions
    let funcRegex = /(count|min|max|avg|sum)(\(.*?\))(&nbsp;|,)/gi
    selectClause = selectClause.replace(funcRegex, ($0, $1, $2, $3) => '<span class="function group-by">' + $1.toUpperCase() + $2 + '</span>' + $3);
    optionalClauses.forEach((optional, i) => {
      optional.clause = optional.clause.replace(funcRegex, ($0, $1, $2, $3) => '<span class="function group-by">' + $1.toUpperCase() + $2 + '</span>' + $3);
    })

    let html = '<p>' + selectKeyword + selectClause + fromKeyword + fromClause + optionalClauses.reduce((str, opt) => str + opt.keyword + opt.clause,'') + '</p>'
    // console.log("OUTPUT HTML:", html)
    return html
  }

  handleActions(action) {
    switch(action.type) {
        case "COLUMN_DROP":
          this.addColumn(action.column)
          break

        case "COLUMN_REMOVE":
          this.removeColumn(action.colIdx)
          break

        case "UPDATE_QUERY":
          this.parseQuery(action.query)
          break

        case "FILTER_COLUMN":
          this.filterColumn(action.column, action.operator, action.value)
          break

        case "GROUP_COLUMN":
          this.groupColumn(action.column, action.func, action.colType)
          break

        case "ORDER_COLUMN":
          this.orderColumn(action.column, action.order, action.sort)
          break
    }
  }
}

const queryStore = new QueryStore
dispatcher.register(queryStore.handleActions.bind(queryStore))

export default queryStore
